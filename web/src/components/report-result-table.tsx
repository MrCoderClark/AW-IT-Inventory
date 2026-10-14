import { cn } from "@/lib/utils";
import type { CellValue, ReportResult } from "@/lib/report-spec";

/**
 * Shared presentational table for a report result (spec 26) — used by the
 * builder's live preview and the saved-report page, so both render identically.
 * Pure (no hooks, no interactivity): safe to render on the server or inside a
 * client component. Number/date columns are right-aligned and tabular.
 */
export function ReportResultTable({
  result,
  className,
}: {
  result: ReportResult;
  className?: string;
}) {
  return (
    <div className={cn("overflow-auto", className)}>
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
                    {formatReportCell(cell)}
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

/** A cell for on-screen display: Yes/No for booleans, date-only for ISO
   timestamps, locale numbers, and an em dash for empties. */
export function formatReportCell(cell: CellValue): string {
  if (cell == null || cell === "") return "—";
  if (cell === true) return "Yes";
  if (cell === false) return "No";
  if (typeof cell === "number") return cell.toLocaleString();
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(cell);
  return m ? m[1] : cell;
}
