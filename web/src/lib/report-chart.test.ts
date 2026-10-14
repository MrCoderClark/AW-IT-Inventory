import { describe, it, expect } from "vitest";

import {
  buildChartData,
  canRenderChart,
  chartableColumns,
  CHART_COLOR_VARS,
  OTHER_COLOR_VAR,
} from "./report-chart";
import type { ReportResult } from "./report-spec";

/**
 * Unit tests for the pure report-chart core (spec 26 phase 2). Locks: only numeric
 * columns are chartable values; per-category summing; descending order; the fixed
 * color ramp assigned in order (never cycled); and the top-5 + "Other" fold.
 */

function result(rows: (string | number)[][]): ReportResult {
  return {
    columns: [
      { id: "type", label: "Type", type: "enum" },
      { id: "_count", label: "Count", type: "number" },
    ],
    rows: rows as ReportResult["rows"],
    totalRows: rows.length,
  };
}

describe("chartableColumns", () => {
  it("offers any column as category but only numeric columns as value", () => {
    const { categories, values } = chartableColumns(result([]));
    expect(categories.map((c) => c.id)).toEqual(["type", "_count"]);
    expect(values.map((c) => c.id)).toEqual(["_count"]);
  });
});

describe("canRenderChart", () => {
  it("requires a category, a numeric value, and at least one row", () => {
    const r = result([["Computer", 3]]);
    expect(canRenderChart(r, { type: "bar", categoryField: "type", valueField: "_count" })).toBe(true);
    // value must be numeric
    expect(canRenderChart(r, { type: "bar", categoryField: "type", valueField: "type" })).toBe(false);
    // no rows
    expect(canRenderChart(result([]), { type: "bar", categoryField: "type", valueField: "_count" })).toBe(false);
  });
});

describe("buildChartData", () => {
  const chart = { type: "bar" as const, categoryField: "type", valueField: "_count" };

  it("sums per category, sorts descending, assigns the ramp in order", () => {
    const r = result([
      ["Computer", 2],
      ["Printer", 5],
      ["Computer", 3], // same label → summed to 5
    ]);
    const { slices, total } = buildChartData(r, chart);
    expect(total).toBe(10);
    // Computer(5) and Printer(5) tie; both present, colored in order, no cycling.
    expect(slices).toHaveLength(2);
    expect(slices[0].colorVar).toBe(CHART_COLOR_VARS[0]);
    expect(slices[1].colorVar).toBe(CHART_COLOR_VARS[1]);
    expect(slices.map((s) => s.value).reduce((a, b) => a + b)).toBe(10);
  });

  it("folds categories past the top five into a neutral 'Other'", () => {
    const r = result([
      ["A", 10],
      ["B", 9],
      ["C", 8],
      ["D", 7],
      ["E", 6],
      ["F", 5],
      ["G", 4],
    ]);
    const { slices, total } = buildChartData(r, chart);
    expect(total).toBe(49);
    // 5 colored (the ramp) + a neutral Other — never a generated 6th hue.
    expect(slices).toHaveLength(CHART_COLOR_VARS.length + 1);
    slices
      .slice(0, CHART_COLOR_VARS.length)
      .forEach((s, i) => expect(s.colorVar).toBe(CHART_COLOR_VARS[i]));
    const other = slices[slices.length - 1];
    expect(other.label).toBe("Other");
    expect(other.colorVar).toBe(OTHER_COLOR_VAR);
    expect(other.value).toBe(5 + 4); // F + G (beyond the top 5)
    // Totals are conserved by the fold.
    expect(slices.reduce((a, s) => a + s.value, 0)).toBe(total);
  });
});
