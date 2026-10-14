import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Lock, Pencil, Sparkles } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { ReportExportMenu } from "@/components/report-export-menu";
import { ReportResultTable } from "@/components/report-result-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getReport, runReportBySpec } from "@/db/report-engine";
import { REPORT_SOURCES } from "@/lib/report-sources";
import type { ReportResult } from "@/lib/report-spec";
import { hasPermission, requireUser } from "@/lib/auth/session";

// Saved reports run live from the fleet on each open — never a stale snapshot.
export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();

  if (!hasPermission(user, "report:read")) {
    return (
      <PagePlaceholder
        title="Report"
        description="You don't have permission to run reports. Ask an admin for the report:read role."
        icon={Lock}
      />
    );
  }

  const { id } = await params;
  const report = await getReport(id);
  if (!report) notFound();

  const canWrite = hasPermission(user, "report:write");
  const sourceLabel = REPORT_SOURCES[report.source]?.label ?? report.source;

  let result: ReportResult | null = null;
  let runError = false;
  try {
    result = await runReportBySpec(report.spec);
  } catch {
    runError = true;
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
      <HeroHeader
        title={report.name}
        subtitle={report.description ?? "Custom report — live from the inventory."}
        icon={<Sparkles />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link href="/reports" />}
            >
              <ArrowLeft /> Back
            </Button>
            {canWrite && (
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link href={`/reports/builder?id=${report.id}`} />}
              >
                <Pencil /> Edit
              </Button>
            )}
            <ReportExportMenu
              source={report.source}
              spec={report.spec}
              name={report.name}
              disabled={!result || result.rows.length === 0}
            />
          </div>
        }
      />

      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <Badge variant="secondary">{sourceLabel}</Badge>
          {result && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {result.totalRows.toLocaleString()} row
              {result.totalRows === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {runError ? (
          <p className="px-4 py-16 text-center text-sm text-destructive">
            Could not run this report. Its definition may reference a data source
            that no longer exists — edit it to fix.
          </p>
        ) : result && result.rows.length > 0 ? (
          <ReportResultTable result={result} className="max-h-[75vh]" />
        ) : (
          <p className="px-4 py-16 text-center text-sm text-muted-foreground">
            No rows match this report.
          </p>
        )}
      </Card>
    </div>
  );
}
