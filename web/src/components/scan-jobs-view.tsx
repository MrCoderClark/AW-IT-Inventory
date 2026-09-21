"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { cancelScanJob } from "@/app/(app)/scan-actions";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ScanJobListItem } from "@/db/scan";

/** Visual treatment per job status. `pending` splits into a distinct
   "waiting for collector" pill when no worker is polling (AC-5). */
const STATUS_STYLE: Record<
  ScanJobListItem["status"],
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "bg-muted text-muted-foreground" },
  claimed: { label: "Claimed", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  running: { label: "Running", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  succeeded: { label: "Succeeded", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive" },
  canceled: { label: "Canceled", className: "bg-muted text-muted-foreground" },
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusPill({ job }: { job: ScanJobListItem }) {
  if (job.waitingForCollector) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
        Waiting for collector
      </span>
    );
  }
  const s = STATUS_STYLE[job.status];
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}

/** One-line summary of a finished job's result, or its error / scope. */
function resultSummary(job: ScanJobListItem): string {
  if (job.status === "failed") return job.error ?? "Worker error.";
  if (job.result) {
    const r = job.result;
    const unreachable = r.targets.filter((t) => t.status !== "ok").length;
    const parts = [
      `${r.matched} matched`,
      `${r.discovered} discovered`,
      `${r.upserted} upserted`,
    ];
    if (unreachable > 0) parts.push(`${unreachable} unreachable`);
    return parts.join(" · ");
  }
  return job.scope === "all" ? "All known devices" : "Selected devices";
}

export function ScanJobsView({
  jobs,
  canScan = false,
}: {
  jobs: ScanJobListItem[];
  canScan?: boolean;
}) {
  const router = useRouter();
  const [cancelingId, setCancelingId] = React.useState<string | null>(null);
  const [isPending, startCancel] = React.useTransition();

  function cancel(id: string) {
    setCancelingId(id);
    startCancel(async () => {
      const res = await cancelScanJob(id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
      setCancelingId(null);
    });
  }

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Scan jobs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manual scans queued from the app. The collector worker claims and
            runs them.
          </p>
        </div>
        <Button variant="outline" onClick={() => router.refresh()}>
          <RefreshCw className="size-4" /> Refresh
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {["Status", "Scope", "Targets", "Result", "Requested by", "Requested", "Finished", ""].map(
                (h, i) => (
                  <TableHead
                    key={i}
                    className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {h}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length ? (
              jobs.map((job) => (
                <TableRow key={job.id} className="whitespace-nowrap">
                  <TableCell>
                    <StatusPill job={job} />
                  </TableCell>
                  <TableCell className="text-muted-foreground capitalize">
                    {job.scope}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {job.targetCount}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {resultSummary(job)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {job.requestedBy}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {fmtTime(job.requestedAt)}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {fmtTime(job.finishedAt)}
                  </TableCell>
                  <TableCell>
                    {canScan && job.status === "pending" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cancel(job.id)}
                        disabled={isPending && cancelingId === job.id}
                      >
                        {isPending && cancelingId === job.id && (
                          <Loader2 className="size-4 animate-spin" />
                        )}
                        Cancel
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-muted-foreground"
                >
                  No scan jobs yet. Start one from a computer&apos;s detail page
                  or the Computers table.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
