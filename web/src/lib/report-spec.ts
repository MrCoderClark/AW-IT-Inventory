/**
 * Custom reporting engine (spec 26) — the pure, client-safe core: the field
 * catalog per data source, the report spec types, and `runReport`, which turns a
 * source's flat rows + a spec into a result (filter → group/aggregate → sort →
 * limit). No DB, no server imports, no user SQL — the builder only ever composes
 * from the whitelisted catalog here, and this is unit-tested in isolation.
 */

export type FieldType = "text" | "number" | "date" | "enum" | "bool";

export interface ReportField {
  id: string;
  label: string;
  type: FieldType;
  /** For `enum` fields: the allowed values (also used for the filter picker). */
  enumValues?: string[];
}

export interface ReportSource {
  id: string;
  label: string;
  description: string;
  fields: ReportField[];
}

export type Operator =
  | "contains"
  | "notContains"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "before"
  | "after"
  | "on"
  | "in"
  | "isTrue"
  | "isFalse"
  | "isEmpty"
  | "isNotEmpty";

/** Which operators each field type offers (drives the builder's operator picker). */
export const OPERATORS_BY_TYPE: Record<FieldType, Operator[]> = {
  text: ["contains", "notContains", "eq", "neq", "isEmpty", "isNotEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isEmpty", "isNotEmpty"],
  date: ["on", "before", "after", "between", "isEmpty", "isNotEmpty"],
  enum: ["in", "eq", "neq", "isEmpty", "isNotEmpty"],
  bool: ["isTrue", "isFalse", "isEmpty"],
};

export const OPERATOR_LABELS: Record<Operator, string> = {
  contains: "contains",
  notContains: "does not contain",
  eq: "is",
  neq: "is not",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  between: "between",
  before: "before",
  after: "after",
  on: "on",
  in: "is any of",
  isTrue: "is yes",
  isFalse: "is no",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

export interface ReportFilter {
  field: string;
  op: Operator;
  value?: string | number | null;
  value2?: string | number | null; // for `between`
  values?: string[]; // for `in`
}

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

export interface ReportAggregate {
  field: string;
  fn: AggregateFn;
}

export interface ReportSort {
  field: string;
  dir: "asc" | "desc";
}

export interface ReportSpec {
  source: string;
  columns: string[];
  filters: ReportFilter[];
  groupBy?: string[];
  aggregates?: ReportAggregate[];
  sort?: ReportSort[];
  limit?: number | null;
}

export type CellValue = string | number | boolean | null;
export type ReportRow = Record<string, CellValue>;

export interface ResultColumn {
  id: string;
  label: string;
  type: FieldType;
}
export interface ReportResult {
  columns: ResultColumn[];
  rows: CellValue[][];
  /** Row count after filtering, before `limit` (so the UI can say "showing 50 of 312"). */
  totalRows: number;
}

/* ----------------------------- filtering ----------------------------- */

function asNum(v: CellValue): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function asTime(v: CellValue): number | null {
  if (v == null || v === "") return null;
  const s = String(v);
  // Bare YYYY-MM-DD → treat as UTC midnight; otherwise parse as-is.
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t) ? null : t;
}

function isEmptyVal(v: CellValue): boolean {
  return v == null || v === "";
}

export function matchFilter(value: CellValue, f: ReportFilter, type: FieldType): boolean {
  switch (f.op) {
    case "isEmpty":
      return isEmptyVal(value);
    case "isNotEmpty":
      return !isEmptyVal(value);
    case "isTrue":
      return value === true;
    case "isFalse":
      return value === false;
  }
  if (type === "number") {
    const a = asNum(value);
    const b = asNum(f.value ?? null);
    if (a == null) return false;
    switch (f.op) {
      case "eq": return a === b;
      case "neq": return a !== b;
      case "gt": return b != null && a > b;
      case "gte": return b != null && a >= b;
      case "lt": return b != null && a < b;
      case "lte": return b != null && a <= b;
      case "between": {
        const b2 = asNum(f.value2 ?? null);
        return b != null && b2 != null && a >= Math.min(b, b2) && a <= Math.max(b, b2);
      }
      default: return false;
    }
  }
  if (type === "date") {
    const a = asTime(value);
    if (a == null) return false;
    const b = asTime((f.value ?? null) as CellValue);
    switch (f.op) {
      case "before": return b != null && a < b;
      case "after": return b != null && a > b;
      case "on": {
        // Same UTC calendar day.
        if (b == null) return false;
        return Math.floor(a / 86_400_000) === Math.floor(b / 86_400_000);
      }
      case "between": {
        const b2 = asTime((f.value2 ?? null) as CellValue);
        return b != null && b2 != null && a >= Math.min(b, b2) && a <= Math.max(b, b2);
      }
      default: return false;
    }
  }
  // text / enum
  const s = value == null ? "" : String(value);
  if (f.op === "in") return (f.values ?? []).some((x) => x === s);
  const q = f.value == null ? "" : String(f.value);
  switch (f.op) {
    case "contains": return s.toLowerCase().includes(q.toLowerCase());
    case "notContains": return !s.toLowerCase().includes(q.toLowerCase());
    case "eq": return s.toLowerCase() === q.toLowerCase();
    case "neq": return s.toLowerCase() !== q.toLowerCase();
    default: return false;
  }
}

/* ----------------------------- aggregation ----------------------------- */

const AGG_LABEL: Record<AggregateFn, string> = {
  count: "Count",
  sum: "Sum",
  avg: "Avg",
  min: "Min",
  max: "Max",
};

function aggregate(rows: ReportRow[], field: string, fn: AggregateFn): CellValue {
  if (fn === "count") return rows.filter((r) => !isEmptyVal(r[field])).length;
  const nums = rows.map((r) => asNum(r[field])).filter((n): n is number => n != null);
  if (nums.length === 0) return null;
  switch (fn) {
    case "sum": return nums.reduce((a, b) => a + b, 0);
    case "avg": return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
    case "min": return Math.min(...nums);
    case "max": return Math.max(...nums);
  }
}

/* ----------------------------- sorting ----------------------------- */

/** Compare two NON-empty values of a type (empties are handled by the sort loop so
   they can sit last regardless of direction). */
function compareVal(a: CellValue, b: CellValue, type: FieldType): number {
  if (type === "number") return (asNum(a) ?? 0) - (asNum(b) ?? 0);
  if (type === "date") return (asTime(a) ?? 0) - (asTime(b) ?? 0);
  if (type === "bool") return a === b ? 0 : a ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

/* ----------------------------- runner ----------------------------- */

/**
 * Run a report spec against a source's rows. `fields` is the source's field
 * catalog (id → ReportField), used for operator/sort typing. Unknown field ids in
 * the spec are ignored (defensive — the spec is validated at the save boundary too).
 */
export function runReport(
  rows: ReportRow[],
  spec: ReportSpec,
  fields: Record<string, ReportField>,
): ReportResult {
  const typeOf = (id: string): FieldType => fields[id]?.type ?? "text";

  // 1. Filter (AND).
  const filtered = rows.filter((row) =>
    spec.filters.every((f) => (fields[f.field] ? matchFilter(row[f.field], f, typeOf(f.field)) : true)),
  );
  const totalRows = filtered.length;

  let columns: ResultColumn[];
  let outRows: CellValue[][];

  const groupBy = (spec.groupBy ?? []).filter((id) => fields[id]);

  if (groupBy.length > 0) {
    // 2a. Group + aggregate.
    const groups = new Map<string, ReportRow[]>();
    for (const row of filtered) {
      const key = groupBy.map((id) => String(row[id] ?? "")).join("\u0000");
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
    }
    const aggs = (spec.aggregates ?? []).filter((a) => fields[a.field]);
    columns = [
      ...groupBy.map((id) => ({ id, label: fields[id].label, type: fields[id].type })),
      { id: "_count", label: "Count", type: "number" as FieldType },
      ...aggs.map((a) => ({
        id: `${a.fn}_${a.field}`,
        label: `${AGG_LABEL[a.fn]} of ${fields[a.field].label}`,
        type: "number" as FieldType,
      })),
    ];
    outRows = [...groups.values()].map((grp) => [
      ...groupBy.map((id) => grp[0][id]),
      grp.length,
      ...aggs.map((a) => aggregate(grp, a.field, a.fn)),
    ]);
  } else {
    // 2b. Project selected columns.
    const cols = spec.columns.filter((id) => fields[id]);
    columns = cols.map((id) => ({ id, label: fields[id].label, type: fields[id].type }));
    outRows = filtered.map((row) => cols.map((id) => row[id] ?? null));
  }

  // 3. Sort (multi-key, stable; empties last).
  const sorts = (spec.sort ?? []).filter((s) => columns.some((c) => c.id === s.field));
  if (sorts.length > 0) {
    const colType = (id: string): FieldType =>
      columns.find((c) => c.id === id)?.type ?? "text";
    const idx = (id: string) => columns.findIndex((c) => c.id === id);
    outRows = outRows
      .map((r, i) => [r, i] as const)
      .sort(([ra, ia], [rb, ib]) => {
        for (const s of sorts) {
          const va = ra[idx(s.field)];
          const vb = rb[idx(s.field)];
          const ea = isEmptyVal(va);
          const eb = isEmptyVal(vb);
          if (ea && eb) continue;
          if (ea) return 1; // empties always last, regardless of direction
          if (eb) return -1;
          const c = compareVal(va, vb, colType(s.field));
          if (c !== 0) return s.dir === "desc" ? -c : c;
        }
        return ia - ib; // stable
      })
      .map(([r]) => r);
  }

  // 4. Limit.
  if (spec.limit && spec.limit > 0) outRows = outRows.slice(0, spec.limit);

  return { columns, rows: outRows, totalRows };
}
