import { BarChart } from "@/components/charts/bar-chart";
import { DonutChart } from "@/components/charts/donut-chart";
import { buildChartData, canRenderChart } from "@/lib/report-chart";
import type { ReportChart, ReportResult } from "@/lib/report-spec";

/**
 * Render a report's chart (spec 26 phase 2) from its result + chart spec, using
 * the in-house BarChart / DonutChart (which already follow the dataviz mark specs).
 * Returns null when the spec can't be drawn (missing/ non-numeric fields, no rows),
 * so it's always safe to mount above the table. Pure/server-safe.
 */
export function ReportChartView({
  result,
  chart,
}: {
  result: ReportResult;
  chart: ReportChart;
}) {
  if (!canRenderChart(result, chart)) return null;

  const { slices, total } = buildChartData(result, chart);
  const valueLabel =
    result.columns.find((c) => c.id === chart.valueField)?.label ?? "Total";

  if (chart.type === "donut") {
    return (
      <DonutChart
        data={slices}
        total={total}
        totalLabel={valueLabel}
        showValues
      />
    );
  }
  return <BarChart data={slices} />;
}
