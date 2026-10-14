"use client";

import * as React from "react";
import { Download, FileSpreadsheet, FileText, Loader2, Table2 } from "lucide-react";
import { toast } from "sonner";

import { runReportAction } from "@/app/(app)/reports/report-actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportReport, type ExportFormat } from "@/lib/report-export";
import type { ReportSpec } from "@/lib/report-spec";

const FORMATS: {
  format: ExportFormat;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { format: "csv", label: "CSV (.csv)", icon: Table2 },
  { format: "xlsx", label: "Excel (.xlsx)", icon: FileSpreadsheet },
  { format: "pdf", label: "PDF (.pdf)", icon: FileText },
];

/**
 * Export a report to CSV / Excel / PDF (spec 26, slice 1c). The result is
 * generated entirely client-side; the office libraries are lazy-loaded on the
 * first export. The menu re-runs the report with its real spec (not the capped
 * 100-row preview) so the file is the whole report, honouring the saved row
 * limit. `report:read` gates the run action server-side.
 */
export function ReportExportMenu({
  source,
  spec,
  name,
  disabled,
}: {
  source: string;
  spec: ReportSpec;
  name: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = React.useState<ExportFormat | null>(null);

  async function run(format: ExportFormat) {
    if (busy) return;
    setBusy(format);
    try {
      const res = await runReportAction(source, spec);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.result.rows.length === 0) {
        toast.error("Nothing to export — this report has no rows.");
        return;
      }
      await exportReport(format, res.result, name.trim() || "report");
      toast.success("Export ready", {
        description: `${res.result.totalRows.toLocaleString()} row${
          res.result.totalRows === 1 ? "" : "s"
        } exported to ${format.toUpperCase()}.`,
      });
    } catch {
      toast.error("Could not generate that export. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" disabled={disabled || busy !== null} />}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Download />}
        Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {FORMATS.map(({ format, label, icon: Icon }) => (
          <DropdownMenuItem
            key={format}
            disabled={busy !== null}
            onClick={() => run(format)}
          >
            <Icon className="size-4 text-muted-foreground" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
