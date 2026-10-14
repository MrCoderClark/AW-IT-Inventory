/**
 * Report charts (spec 26 phase 2) — the pure, client-safe core: which result
 * columns can drive a chart, and turning a `ReportResult` + a `ReportChart` into
 * the `{label, value, colorVar}` slices the in-house BarChart/DonutChart consume.
 * No DB, no React — unit-tested, and shared by the builder preview and the saved
 * report page.
 *
 * Color: a fixed 5-hue categorical ramp (the same `--chart-N` tokens the dashboard
 * uses), assigned in order and NEVER cycled — categories past the top 5 fold into a
 * neutral "Other" bucket (dataviz rule). Identity is carried by direct labels /
 * legend and the always-present table, not color alone.
 */

import type { ReportChart, ReportResult, ResultColumn } from "./report-spec";

// The same fixed 5-hue categorical ramp the dashboard uses, in order.
export const CHART_COLOR_VARS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/** A neutral ink for the folded "Other" bucket — distinct from the 5 hues. */
export const OTHER_COLOR_VAR = "var(--muted-foreground)";

const MAX_SLICES = CHART_COLOR_VARS.length;

export interface ChartSlice {
  label: string;
  value: number;
  colorVar: string;
}

/** The columns a chart can use: any column is a valid category; only numeric
   columns (incl. a group `_count`) are valid values. */
export function chartableColumns(result: ReportResult): {
  categories: ResultColumn[];
  values: ResultColumn[];
} {
  return {
    categories: result.columns,
    values: result.columns.filter((c) => c.type === "number"),
  };
}

/** True when a chart spec can actually be drawn against this result. */
export function canRenderChart(result: ReportResult, chart: ReportChart): boolean {
  const cat = result.columns.some((c) => c.id === chart.categoryField);
  const val = result.columns.some(
    (c) => c.id === chart.valueField && c.type === "number",
  );
  return cat && val && result.rows.length > 0;
}

/** Build the chart slices: sum the value column per category label, sort
   descending, keep the top 5 (colored), fold the rest into a neutral "Other". */
export function buildChartData(
  result: ReportResult,
  chart: ReportChart,
): { slices: ChartSlice[]; total: number } {
  const catIdx = result.columns.findIndex((c) => c.id === chart.categoryField);
  const valIdx = result.columns.findIndex((c) => c.id === chart.valueField);
  if (catIdx < 0 || valIdx < 0) return { slices: [], total: 0 };

  const sums = new Map<string, number>();
  for (const row of result.rows) {
    const raw = row[catIdx];
    const label = raw == null || raw === "" ? "—" : String(raw);
    const n = Number(row[valIdx]);
    if (!Number.isFinite(n)) continue;
    sums.set(label, (sums.get(label) ?? 0) + n);
  }

  const sorted = [...sums.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  const total = sorted.reduce((a, s) => a + s.value, 0);

  const slices: ChartSlice[] = [];
  if (sorted.length <= MAX_SLICES) {
    sorted.forEach((s, i) =>
      slices.push({ ...s, colorVar: CHART_COLOR_VARS[i] }),
    );
  } else {
    // Top MAX_SLICES colored, the remainder summed into a neutral "Other".
    sorted
      .slice(0, MAX_SLICES)
      .forEach((s, i) => slices.push({ ...s, colorVar: CHART_COLOR_VARS[i] }));
    const rest = sorted.slice(MAX_SLICES);
    slices.push({
      label: "Other",
      value: rest.reduce((a, s) => a + s.value, 0),
      colorVar: OTHER_COLOR_VAR,
    });
  }

  return { slices, total };
}
