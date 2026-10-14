"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Layers,
  Loader2,
  Plus,
  Save,
  SlidersHorizontal,
  Table2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  runReportAction,
  saveReportAction,
} from "@/app/(app)/reports/report-actions";
import { ReportExportMenu } from "@/components/report-export-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  fieldMap,
  REPORT_SOURCES,
  REPORT_SOURCE_LIST,
} from "@/lib/report-sources";
import {
  OPERATOR_LABELS,
  OPERATORS_BY_TYPE,
  type AggregateFn,
  type FieldType,
  type Operator,
  type ReportAggregate,
  type ReportFilter,
  type ReportResult,
  type ReportSort,
  type ReportSpec,
} from "@/lib/report-spec";
import { cn } from "@/lib/utils";

const AGG_FNS: { value: AggregateFn; label: string }[] = [
  { value: "count", label: "Count" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

/** Operators that stand alone with no value input. */
const NO_VALUE_OPS = new Set<Operator>([
  "isEmpty",
  "isNotEmpty",
  "isTrue",
  "isFalse",
]);

const PREVIEW_LIMIT = 100;

export interface ReportBuilderInitial {
  id: string;
  name: string;
  description: string | null;
  source: string;
  spec: ReportSpec;
}

/**
 * The custom report builder (spec 26, slice 1b). Pick a data source, choose
 * columns, add type-aware filters, optionally group + aggregate, sort and limit
 * — with a live preview that re-runs server-side as the spec changes. Saving a
 * definition needs `report:write` (the button is hidden without it and the
 * server rechecks). The whole UI composes from the whitelisted field catalog;
 * there is no free-text query anywhere.
 */
export function ReportBuilder({
  initial,
  canWrite,
}: {
  initial?: ReportBuilderInitial;
  canWrite: boolean;
}) {
  const router = useRouter();

  const [source, setSource] = React.useState(initial?.source ?? "assets");
  const [columns, setColumns] = React.useState<string[]>(
    initial?.spec.columns ?? defaultColumns(initial?.source ?? "assets"),
  );
  const [filters, setFilters] = React.useState<ReportFilter[]>(
    initial?.spec.filters ?? [],
  );
  const [groupBy, setGroupBy] = React.useState<string[]>(
    initial?.spec.groupBy ?? [],
  );
  const [aggregates, setAggregates] = React.useState<ReportAggregate[]>(
    initial?.spec.aggregates ?? [],
  );
  const [sort, setSort] = React.useState<ReportSort[]>(initial?.spec.sort ?? []);
  const [limit, setLimit] = React.useState<string>(
    initial?.spec.limit ? String(initial.spec.limit) : "",
  );

  const [name, setName] = React.useState(initial?.name ?? "");
  const [description, setDescription] = React.useState(
    initial?.description ?? "",
  );

  const [result, setResult] = React.useState<ReportResult | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, startSave] = React.useTransition();

  const src = REPORT_SOURCES[source];
  const fields = React.useMemo(() => fieldMap(source), [source]);
  const typeOf = React.useCallback(
    (id: string): FieldType => fields[id]?.type ?? "text",
    [fields],
  );

  const grouped = groupBy.length > 0;

  /* The spec assembled from the controls — the single source of truth both the
     preview and Save send to the server. */
  const spec = React.useMemo<ReportSpec>(() => {
    const n = Number(limit);
    return {
      source,
      columns,
      filters,
      groupBy,
      aggregates,
      sort,
      limit: Number.isFinite(n) && n > 0 ? n : null,
    };
  }, [source, columns, filters, groupBy, aggregates, sort, limit]);

  const hasOutput = columns.length > 0 || groupBy.length > 0;

  /* Live preview: re-run server-side (debounced) whenever the spec changes. A
     monotonic request id drops stale responses that land out of order; the empty
     case is handled by PreviewBody (it checks `hasOutput` first), so nothing is
     set synchronously in the effect body. */
  const specKey = JSON.stringify(spec);
  const reqRef = React.useRef(0);
  React.useEffect(() => {
    if (!hasOutput) return;
    const myReq = ++reqRef.current;
    const t = setTimeout(async () => {
      setRunning(true);
      const res = await runReportAction(source, {
        ...spec,
        limit: PREVIEW_LIMIT,
      });
      if (myReq !== reqRef.current) return; // a newer run superseded this one
      if (res.ok) {
        setResult(res.result);
        setError(null);
      } else {
        setResult(null);
        setError(res.error);
      }
      setRunning(false);
    }, 350);
    return () => clearTimeout(t);
    // specKey captures every field of `spec`; source is part of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, hasOutput]);

  /* ---------------- mutators ---------------- */

  function changeSource(next: string) {
    setSource(next);
    setColumns(defaultColumns(next));
    setFilters([]);
    setGroupBy([]);
    setAggregates([]);
    setSort([]);
  }

  function toggleColumn(id: string) {
    setColumns((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  }

  function moveColumn(index: number, dir: -1 | 1) {
    setColumns((prev) => {
      const next = index + dir;
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  }

  function addFilter(fieldId: string) {
    const t = typeOf(fieldId);
    setFilters((prev) => [
      ...prev,
      { field: fieldId, op: OPERATORS_BY_TYPE[t][0] },
    ]);
  }

  function updateFilter(index: number, patch: Partial<ReportFilter>) {
    setFilters((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    );
  }

  function removeFilter(index: number) {
    setFilters((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleGroup(id: string) {
    setGroupBy((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );
    // Dropping all groupings clears the sort if it referenced _count.
    setSort((prev) => prev.filter((s) => s.field !== "_count"));
  }

  /* Fields valid to sort by, given the current mode (see the engine: a saved
     sort must reference a projected column, which is a source field in column
     mode or a groupBy field / _count in group mode). */
  const sortableFields: { id: string; label: string }[] = grouped
    ? [
        ...groupBy.map((id) => ({ id, label: fields[id]?.label ?? id })),
        { id: "_count", label: "Count" },
      ]
    : columns.map((id) => ({ id, label: fields[id]?.label ?? id }));

  function onSave() {
    startSave(async () => {
      const res = await saveReportAction({
        id: initial?.id,
        name,
        description,
        source,
        spec,
      });
      if (res.ok) {
        toast.success(res.message);
        router.push(`/reports/custom/${res.id}`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const unusedColumnFields = src.fields.filter((f) => !columns.includes(f.id));
  const unusedFilterFields = src.fields;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      {/* ------------------- Builder controls ------------------- */}
      <div className="flex flex-col gap-4">
        {/* Data source */}
        <Card className="gap-3 p-4">
          <SectionTitle icon={Table2}>Data source</SectionTitle>
          <Select value={source} onValueChange={(v) => v && changeSource(v)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORT_SOURCE_LIST.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{src.description}</p>
        </Card>

        {/* Columns */}
        <Card className="gap-3 p-4">
          <SectionTitle icon={Table2}>
            Columns
            {grouped && (
              <Badge variant="secondary" className="ml-auto font-normal">
                replaced by grouping
              </Badge>
            )}
          </SectionTitle>

          {grouped ? (
            <p className="text-xs text-muted-foreground">
              Grouping is on, so the result shows the group keys and aggregates
              below instead of these columns.
            </p>
          ) : (
            <>
              {columns.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No columns yet — add at least one.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {columns.map((id, i) => (
                    <li
                      key={id}
                      className="flex items-center gap-1 rounded-md border bg-card px-2 py-1"
                    >
                      <span className="flex-1 truncate text-sm">
                        {fields[id]?.label ?? id}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => moveColumn(i, -1)}
                        disabled={i === 0}
                        aria-label={`Move ${fields[id]?.label ?? id} up`}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => moveColumn(i, 1)}
                        disabled={i === columns.length - 1}
                        aria-label={`Move ${fields[id]?.label ?? id} down`}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => toggleColumn(id)}
                        aria-label={`Remove ${fields[id]?.label ?? id}`}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {unusedColumnFields.length > 0 && (
                <AddPicker
                  placeholder="Add a column…"
                  options={unusedColumnFields.map((f) => ({
                    value: f.id,
                    label: f.label,
                  }))}
                  onPick={toggleColumn}
                />
              )}
            </>
          )}
        </Card>

        {/* Filters */}
        <Card className="gap-3 p-4">
          <SectionTitle icon={SlidersHorizontal}>Filters</SectionTitle>
          {filters.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No filters — every row is included. Filters are combined with AND.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {filters.map((f, i) => (
                <FilterRow
                  key={i}
                  filter={f}
                  field={fields[f.field]}
                  onChange={(patch) => updateFilter(i, patch)}
                  onRemove={() => removeFilter(i)}
                />
              ))}
            </ul>
          )}
          <AddPicker
            placeholder="Add a filter…"
            options={unusedFilterFields.map((f) => ({
              value: f.id,
              label: f.label,
            }))}
            onPick={addFilter}
          />
        </Card>

        {/* Group + aggregate */}
        <Card className="gap-3 p-4">
          <SectionTitle icon={Layers}>Group &amp; summarize</SectionTitle>
          <p className="text-xs text-muted-foreground">
            Group rows by one or more fields to get counts and totals per group.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {src.fields.map((f) => {
              const on = groupBy.includes(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggleGroup(f.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-input text-muted-foreground hover:border-primary/50",
                  )}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {grouped && (
            <div className="flex flex-col gap-2 border-t pt-3">
              <span className="text-xs font-medium text-muted-foreground">
                Aggregates (each group always includes a row count)
              </span>
              {aggregates.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Select
                    value={a.fn}
                    onValueChange={(v) =>
                      v &&
                      setAggregates((prev) =>
                        prev.map((x, j) =>
                          j === i ? { ...x, fn: v as AggregateFn } : x,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGG_FNS.map((fn) => (
                        <SelectItem key={fn.value} value={fn.value}>
                          {fn.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={a.field}
                    onValueChange={(v) =>
                      v &&
                      setAggregates((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, field: v } : x)),
                      )
                    }
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="field" />
                    </SelectTrigger>
                    <SelectContent>
                      {src.fields
                        .filter(
                          (f) => a.fn === "count" || f.type === "number",
                        )
                        .map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.label}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      setAggregates((prev) => prev.filter((_, j) => j !== i))
                    }
                    aria-label="Remove aggregate"
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  setAggregates((prev) => [
                    ...prev,
                    { fn: "count", field: src.fields[0].id },
                  ])
                }
              >
                <Plus /> Add aggregate
              </Button>
            </div>
          )}
        </Card>

        {/* Sort + limit */}
        <Card className="gap-3 p-4">
          <SectionTitle icon={SlidersHorizontal}>Sort &amp; limit</SectionTitle>
          {sort.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Select
                value={s.field}
                onValueChange={(v) =>
                  v &&
                  setSort((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, field: v } : x)),
                  )
                }
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="field" />
                </SelectTrigger>
                <SelectContent>
                  {sortableFields.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={s.dir}
                onValueChange={(v) =>
                  v &&
                  setSort((prev) =>
                    prev.map((x, j) =>
                      j === i ? { ...x, dir: v as "asc" | "desc" } : x,
                    ),
                  )
                }
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc">Ascending</SelectItem>
                  <SelectItem value="desc">Descending</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSort((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove sort"
              >
                <X />
              </Button>
            </div>
          ))}
          {sortableFields.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                setSort((prev) => [
                  ...prev,
                  { field: sortableFields[0].id, dir: "asc" },
                ])
              }
            >
              <Plus /> Add sort
            </Button>
          )}
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Limit rows</span>
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="all"
              className="w-28"
            />
          </label>
        </Card>
      </div>

      {/* ------------------- Preview + save ------------------- */}
      <div className="flex flex-col gap-4">
        <Card className="gap-3 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Report name
              </span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Dell laptops out of warranty"
                maxLength={120}
              />
            </label>
            {canWrite && (
              <Button onClick={onSave} disabled={saving || !hasOutput}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />}
                {initial ? "Save changes" : "Save report"}
              </Button>
            )}
          </div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description — what this report answers."
            rows={2}
          />
          {!canWrite && (
            <p className="text-xs text-muted-foreground">
              You can run and preview reports; saving needs the{" "}
              <code className="font-mono">report:write</code> permission.
            </p>
          )}
        </Card>

        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex items-center gap-3">
              <h2 className="font-heading text-sm font-semibold">Preview</h2>
              <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                {running && <Loader2 className="size-3.5 animate-spin" />}
                {result &&
                  (result.totalRows > result.rows.length
                    ? `Showing ${result.rows.length} of ${result.totalRows.toLocaleString()} rows`
                    : `${result.totalRows.toLocaleString()} row${result.totalRows === 1 ? "" : "s"}`)}
              </span>
            </div>
            <ReportExportMenu
              source={source}
              spec={spec}
              name={name}
              disabled={!hasOutput}
            />
          </div>

          <PreviewBody
            hasOutput={hasOutput}
            error={error}
            result={result}
          />
        </Card>
      </div>
    </div>
  );
}

/* ================================================================
   Sub-components
   ================================================================ */

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <h2 className="flex items-center gap-2 font-heading text-sm font-semibold">
      <Icon className="size-4 text-muted-foreground" />
      {children}
    </h2>
  );
}

/** A reset-on-pick Select used to append a column or filter from a field list. */
function AddPicker({
  placeholder,
  options,
  onPick,
}: {
  placeholder: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
}) {
  // A nonce bumped on each pick forces the Select back to its empty state so the
  // same field can be added again (relevant for filters).
  const [nonce, setNonce] = React.useState(0);
  return (
    <Select
      key={nonce}
      value={null}
      onValueChange={(v) => {
        if (v) {
          onPick(v);
          setNonce((n) => n + 1);
        }
      }}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FilterRow({
  filter,
  field,
  onChange,
  onRemove,
}: {
  filter: ReportFilter;
  field: { id: string; label: string; type: FieldType; enumValues?: string[] } | undefined;
  onChange: (patch: Partial<ReportFilter>) => void;
  onRemove: () => void;
}) {
  const type = field?.type ?? "text";
  const ops = OPERATORS_BY_TYPE[type];

  return (
    <li className="flex flex-col gap-1.5 rounded-md border bg-card p-2">
      <div className="flex items-center gap-1.5">
        <span className="flex-1 truncate text-sm font-medium">
          {field?.label ?? filter.field}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          aria-label="Remove filter"
        >
          <X />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={filter.op}
          onValueChange={(v) =>
            v && onChange({ op: v as Operator, value: undefined, value2: undefined, values: undefined })
          }
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ops.map((op) => (
              <SelectItem key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FilterValue
          filter={filter}
          type={type}
          enumValues={field?.enumValues}
          onChange={onChange}
        />
      </div>
    </li>
  );
}

function FilterValue({
  filter,
  type,
  enumValues,
  onChange,
}: {
  filter: ReportFilter;
  type: FieldType;
  enumValues?: string[];
  onChange: (patch: Partial<ReportFilter>) => void;
}) {
  if (NO_VALUE_OPS.has(filter.op)) return null;

  // enum "is any of" → multi toggle
  if (type === "enum" && filter.op === "in") {
    const selected = new Set(filter.values ?? []);
    return (
      <div className="flex flex-wrap gap-1">
        {(enumValues ?? []).map((v) => {
          const on = selected.has(v);
          return (
            <button
              key={v}
              type="button"
              onClick={() => {
                const next = new Set(selected);
                if (on) next.delete(v);
                else next.add(v);
                onChange({ values: [...next] });
              }}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs transition-colors",
                on
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-input text-muted-foreground hover:border-primary/50",
              )}
            >
              {v}
            </button>
          );
        })}
      </div>
    );
  }

  // enum eq/neq → single Select
  if (type === "enum") {
    return (
      <Select
        value={(filter.value as string) ?? null}
        onValueChange={(v) => v != null && onChange({ value: v })}
      >
        <SelectTrigger className="w-40">
          <SelectValue placeholder="value" />
        </SelectTrigger>
        <SelectContent>
          {(enumValues ?? []).map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const inputType = type === "number" ? "number" : type === "date" ? "date" : "text";

  if (filter.op === "between") {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type={inputType}
          value={(filter.value as string | number | null) ?? ""}
          onChange={(e) => onChange({ value: e.target.value })}
          className="w-32"
        />
        <span className="text-xs text-muted-foreground">and</span>
        <Input
          type={inputType}
          value={(filter.value2 as string | number | null) ?? ""}
          onChange={(e) => onChange({ value2: e.target.value })}
          className="w-32"
        />
      </div>
    );
  }

  return (
    <Input
      type={inputType}
      value={(filter.value as string | number | null) ?? ""}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder="value"
      className="w-44"
    />
  );
}

function PreviewBody({
  hasOutput,
  error,
  result,
}: {
  hasOutput: boolean;
  error: string | null;
  result: ReportResult | null;
}) {
  if (!hasOutput) {
    return (
      <p className="px-4 py-16 text-center text-sm text-muted-foreground">
        Pick at least one column (or a grouping) to preview the report.
      </p>
    );
  }
  if (error) {
    return (
      <p className="px-4 py-16 text-center text-sm text-destructive">{error}</p>
    );
  }
  if (!result) {
    return (
      <p className="px-4 py-16 text-center text-sm text-muted-foreground">
        Loading preview…
      </p>
    );
  }
  if (result.rows.length === 0) {
    return (
      <p className="px-4 py-16 text-center text-sm text-muted-foreground">
        No rows match this report.
      </p>
    );
  }

  return (
    <div className="max-h-[70vh] overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
          <tr>
            {result.columns.map((c) => (
              <th
                key={c.id}
                className={cn(
                  "whitespace-nowrap border-b px-3 py-2 text-left font-medium",
                  (c.type === "number" || c.type === "date") && "text-right",
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, ri) => (
            <tr key={ri} className="hover:bg-muted/40">
              {row.map((cell, ci) => {
                const col = result.columns[ci];
                return (
                  <td
                    key={ci}
                    className={cn(
                      "whitespace-nowrap border-b px-3 py-1.5",
                      (col.type === "number" || col.type === "date") &&
                        "text-right font-mono tabular-nums",
                    )}
                  >
                    {formatCell(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- helpers ---------------- */

/** The first five fields of a source — a sensible starting column set. */
function defaultColumns(sourceId: string): string[] {
  return (REPORT_SOURCES[sourceId]?.fields ?? []).slice(0, 5).map((f) => f.id);
}

function formatCell(cell: string | number | boolean | null): string {
  if (cell == null || cell === "") return "—";
  if (cell === true) return "Yes";
  if (cell === false) return "No";
  if (typeof cell === "number") return cell.toLocaleString();
  // ISO timestamp → date only, for readability.
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(cell);
  return m ? m[1] : cell;
}
