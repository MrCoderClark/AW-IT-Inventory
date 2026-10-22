"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDownUp, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { requestFleetOsPatchInstall } from "@/app/(app)/patch-install-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FleetOsSkipReason } from "@/db/patch-install";
import type { FleetPatchRow } from "@/db/patches";

/**
 * Fleet table for `/patches` (spec 31, AC-4). Sortable by attention: pending
 * reboot and stale OS first, then app upgrades waiting.
 */

function attentionScore(r: FleetPatchRow): number {
  let s = 0;
  if (r.pendingReboot) s += 100;
  if (r.missingCount > 0) s += Math.min(40 + r.missingCount, 80);
  if (r.updatesLastDays != null && r.updatesLastDays > 30) s += 50;
  if (r.appUpgradeCount > 0) s += Math.min(r.appUpgradeCount, 20);
  if (r.wingetAvailable === false) s += 10;
  if (r.collectedAt == null) s += 5;
  return s;
}

function wingetLabel(r: FleetPatchRow): string {
  if (r.collectedAt == null) return "—";
  if (r.wingetAvailable === true) return "OK";
  if (r.wingetAvailable === false) return "Missing";
  return "Skipped";
}

const SKIP_LABEL: Record<FleetOsSkipReason, string> = {
  "no-ip": "no IP",
  "no-missing": "no missing OS updates",
  "already-inflight": "install already in progress",
  "not-found": "not found",
};

function fleetInstallSummary(enqueued: number, skipped: number): string {
  if (enqueued === 0 && skipped === 0) return "";
  const parts: string[] = [];
  if (enqueued > 0) {
    parts.push(
      `${enqueued} install${enqueued === 1 ? "" : "s"} queued`,
    );
  }
  if (skipped > 0) {
    parts.push(`${skipped} skipped`);
  }
  return parts.join("; ");
}

export function PatchesFleet({
  rows,
  canDeploy = false,
}: {
  rows: FleetPatchRow[];
  canDeploy?: boolean;
}) {
  const router = useRouter();
  const [desc, setDesc] = React.useState(true); // worst first
  const [needsAttentionOnly, setNeedsAttentionOnly] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [summary, setSummary] = React.useState<string | null>(null);
  const [busy, startBusy] = React.useTransition();

  const view = React.useMemo(() => {
    let r = rows;
    if (needsAttentionOnly) {
      r = r.filter(
        (x) =>
          x.pendingReboot ||
          x.missingCount > 0 ||
          (x.updatesLastDays != null && x.updatesLastDays > 30) ||
          x.appUpgradeCount > 0 ||
          x.wingetAvailable === false ||
          x.collectedAt == null,
      );
    }
    return [...r].sort((a, b) =>
      desc
        ? attentionScore(b) - attentionScore(a)
        : attentionScore(a) - attentionScore(b),
    );
  }, [rows, desc, needsAttentionOnly]);

  const viewTags = React.useMemo(() => view.map((r) => r.tag), [view]);
  const allViewSelected =
    viewTags.length > 0 && viewTags.every((t) => selected.has(t));
  const someViewSelected =
    viewTags.some((t) => selected.has(t)) && !allViewSelected;

  function toggleTag(tag: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(tag)) n.delete(tag);
      else n.add(tag);
      return n;
    });
  }

  function toggleAllView() {
    setSelected((prev) => {
      const n = new Set(prev);
      if (allViewSelected) {
        for (const t of viewTags) n.delete(t);
      } else {
        for (const t of viewTags) n.add(t);
      }
      return n;
    });
  }

  function doInstall() {
    startBusy(async () => {
      const res = await requestFleetOsPatchInstall({
        assetTags: [...selected],
      });
      setConfirmOpen(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const msg = fleetInstallSummary(res.enqueued.length, res.skipped.length);
      setSummary(msg);
      if (res.enqueued.length > 0) {
        toast.success(msg);
      } else if (res.skipped.length > 0) {
        toast.message(msg, {
          description: res.skipped
            .slice(0, 5)
            .map((s) => `${s.tag}: ${SKIP_LABEL[s.reason as FleetOsSkipReason] ?? s.reason}`)
            .join("; "),
        });
      }
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={needsAttentionOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setNeedsAttentionOnly((v) => !v)}
          >
            {needsAttentionOnly
              ? "Showing needs attention"
              : "Show needs attention only"}
          </Button>
          {canDeploy && (
            <Button
              size="sm"
              disabled={selected.size === 0 || busy}
              onClick={() => setConfirmOpen(true)}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Install OS updates
              {selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {view.length} of {rows.length} computers
        </span>
      </div>

      {summary && (
        <p className="text-sm text-muted-foreground" role="status">
          {summary}
        </p>
      )}

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              {canDeploy && (
                <TableHead className="w-10 px-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={allViewSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someViewSelected;
                    }}
                    onChange={toggleAllView}
                    disabled={busy || view.length === 0}
                    aria-label="Select all computers in view"
                  />
                </TableHead>
              )}
              <TableHead>Computer</TableHead>
              <TableHead>
                <button
                  type="button"
                  onClick={() => setDesc((v) => !v)}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  Attention <ArrowDownUp className="size-3" />
                </button>
              </TableHead>
              <TableHead>Pending reboot</TableHead>
              <TableHead>OS missing</TableHead>
              <TableHead>Last update</TableHead>
              <TableHead>App upgrades</TableHead>
              <TableHead>Winget</TableHead>
              <TableHead className="text-right">KBs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={canDeploy ? 9 : 8}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No computers to show.
                </TableCell>
              </TableRow>
            ) : (
              view.map((r) => (
                <TableRow key={r.tag}>
                  {canDeploy && (
                    <TableCell className="px-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={selected.has(r.tag)}
                        onChange={() => toggleTag(r.tag)}
                        onClick={(e) => e.stopPropagation()}
                        disabled={busy}
                        aria-label={`Select ${r.name}`}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <Link
                      href={`/assets/${r.tag}`}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums text-xs text-muted-foreground">
                    {attentionScore(r) || "—"}
                  </TableCell>
                  <TableCell>
                    {r.pendingReboot ? (
                      <span className="text-sm font-medium text-destructive">
                        Yes
                      </span>
                    ) : r.pendingReboot === false ? (
                      <span className="text-sm text-muted-foreground">No</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">
                    {r.missingCount > 0 ? (
                      <span className="font-medium text-destructive">
                        {r.missingCount}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">
                    {r.updatesLastDays == null ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : r.updatesLastDays > 30 ? (
                      <span className="font-medium text-destructive">
                        {r.updatesLastDays}d
                      </span>
                    ) : (
                      `${r.updatesLastDays}d`
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">
                    {r.appUpgradeCount > 0 ? (
                      <span className="font-medium text-status-maintenance">
                        {r.appUpgradeCount}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {wingetLabel(r) === "Missing" ? (
                      <span className="text-status-maintenance">Missing</span>
                    ) : (
                      <span className="text-muted-foreground">
                        {wingetLabel(r)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                    {r.collectedAt == null ? "—" : r.hotfixCount}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Install OS updates on {selected.size} computer
              {selected.size === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Each selected computer will get all of its currently missing OS
              updates over WinRM. Hosts will <strong>not</strong> be rebooted
              automatically. Installs run with a fleet concurrency limit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={doInstall}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
