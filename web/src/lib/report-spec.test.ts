import { describe, it, expect } from "vitest";

import { runReport, type ReportField, type ReportRow, type ReportSpec } from "./report-spec";

const fields: Record<string, ReportField> = {
  name: { id: "name", label: "Name", type: "text" },
  type: { id: "type", label: "Type", type: "enum", enumValues: ["Computer", "Monitor"] },
  vendor: { id: "vendor", label: "Vendor", type: "text" },
  ramGb: { id: "ramGb", label: "RAM", type: "number" },
  warrantyUntil: { id: "warrantyUntil", label: "Warranty", type: "date" },
  atRisk: { id: "atRisk", label: "At risk", type: "bool" },
};

const ROWS: ReportRow[] = [
  { name: "PC-1", type: "Computer", vendor: "Dell", ramGb: 16, warrantyUntil: "2025-01-01", atRisk: true },
  { name: "PC-2", type: "Computer", vendor: "Dell", ramGb: 32, warrantyUntil: "2027-06-01", atRisk: false },
  { name: "PC-3", type: "Computer", vendor: "HP", ramGb: 8, warrantyUntil: null, atRisk: true },
  { name: "MON-1", type: "Monitor", vendor: "Dell", ramGb: null, warrantyUntil: "2026-12-01", atRisk: null },
];

const base = (p: Partial<ReportSpec>): ReportSpec => ({
  source: "assets",
  columns: ["name"],
  filters: [],
  ...p,
});

describe("runReport — filtering", () => {
  it("text contains (case-insensitive) + reports totalRows before limit", () => {
    const r = runReport(ROWS, base({ columns: ["name", "vendor"], filters: [{ field: "vendor", op: "contains", value: "del" }] }), fields);
    expect(r.totalRows).toBe(3);
    expect(r.rows.map((row) => row[0])).toEqual(["PC-1", "PC-2", "MON-1"]);
  });

  it("number gt", () => {
    const r = runReport(ROWS, base({ filters: [{ field: "ramGb", op: "gt", value: 16 }] }), fields);
    expect(r.rows.map((x) => x[0])).toEqual(["PC-2"]);
  });

  it("number between (inclusive, order-agnostic)", () => {
    const r = runReport(ROWS, base({ filters: [{ field: "ramGb", op: "between", value: 8, value2: 16 }] }), fields);
    expect(r.rows.map((x) => x[0]).sort()).toEqual(["PC-1", "PC-3"]);
  });

  it("date before (nulls excluded)", () => {
    const r = runReport(ROWS, base({ filters: [{ field: "warrantyUntil", op: "before", value: "2026-01-01" }] }), fields);
    expect(r.rows.map((x) => x[0])).toEqual(["PC-1"]); // PC-3 null is excluded
  });

  it("enum in", () => {
    const r = runReport(ROWS, base({ filters: [{ field: "type", op: "in", values: ["Monitor"] }] }), fields);
    expect(r.rows.map((x) => x[0])).toEqual(["MON-1"]);
  });

  it("bool isTrue", () => {
    const r = runReport(ROWS, base({ filters: [{ field: "atRisk", op: "isTrue" }] }), fields);
    expect(r.rows.map((x) => x[0]).sort()).toEqual(["PC-1", "PC-3"]);
  });

  it("isEmpty / isNotEmpty", () => {
    expect(runReport(ROWS, base({ filters: [{ field: "ramGb", op: "isEmpty" }] }), fields).rows.map((x) => x[0])).toEqual(["MON-1"]);
    expect(runReport(ROWS, base({ filters: [{ field: "warrantyUntil", op: "isNotEmpty" }] }), fields).totalRows).toBe(3);
  });

  it("ANDs multiple filters", () => {
    const r = runReport(ROWS, base({ filters: [{ field: "vendor", op: "eq", value: "Dell" }, { field: "type", op: "eq", value: "Computer" }] }), fields);
    expect(r.rows.map((x) => x[0]).sort()).toEqual(["PC-1", "PC-2"]);
  });
});

describe("runReport — grouping + aggregates", () => {
  it("groups with a Count and a sum aggregate", () => {
    const r = runReport(
      ROWS,
      base({ columns: [], groupBy: ["vendor"], aggregates: [{ field: "ramGb", fn: "sum" }], sort: [{ field: "vendor", dir: "asc" }] }),
      fields,
    );
    expect(r.columns.map((c) => c.id)).toEqual(["vendor", "_count", "sum_ramGb"]);
    // Dell: 3 rows, ram 16+32+(null)=48 ; HP: 1 row, ram 8.
    expect(r.rows).toEqual([
      ["Dell", 3, 48],
      ["HP", 1, 8],
    ]);
  });

  it("avg ignores nulls", () => {
    const r = runReport(ROWS, base({ columns: [], groupBy: ["vendor"], aggregates: [{ field: "ramGb", fn: "avg" }], sort: [{ field: "vendor", dir: "asc" }] }), fields);
    // Dell avg over 16,32 = 24 (null skipped); HP = 8.
    expect(r.rows).toEqual([
      ["Dell", 3, 24],
      ["HP", 1, 8],
    ]);
  });
});

describe("runReport — sort + limit", () => {
  it("sorts by number desc and limits", () => {
    const r = runReport(ROWS, base({ columns: ["name", "ramGb"], sort: [{ field: "ramGb", dir: "desc" }], limit: 2 }), fields);
    expect(r.rows.map((x) => x[0])).toEqual(["PC-2", "PC-1"]);
    expect(r.totalRows).toBe(4); // limit doesn't change totalRows
  });

  it("empties sort last regardless of direction", () => {
    const asc = runReport(ROWS, base({ columns: ["name", "ramGb"], sort: [{ field: "ramGb", dir: "asc" }] }), fields);
    expect(asc.rows.map((x) => x[0])).toEqual(["PC-3", "PC-1", "PC-2", "MON-1"]); // MON-1 (null) last
  });
});
