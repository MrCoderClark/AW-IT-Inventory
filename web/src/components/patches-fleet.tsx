"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDownUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FleetPatchRow } from "@/db/patches";

/**
 * Fleet table for `/patches` (spec 31, AC-4). Sortable by attention: pending
 * reboot and stale OS first, then app upgrades waiting.
 */

function attentionScore(r: FleetPatchRow): number {
  let s = 0;
  if (r.pendingReboot) s += 100;
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

export function PatchesFleet({ rows }: { rows: FleetPatchRow[] }) {
  const [desc, setDesc] = React.useState(true); // worst first
  const [needsAttentionOnly, setNeedsAttentionOnly] = React.useState(false);

  const view = React.useMemo(() => {
    let r = rows;
    if (needsAttentionOnly) {
      r = r.filter(
        (x) =>
          x.pendingReboot ||
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant={needsAttentionOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setNeedsAttentionOnly((v) => !v)}
        >
          {needsAttentionOnly
            ? "Showing needs attention"
            : "Show needs attention only"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {view.length} of {rows.length} computers
        </span>
      </div>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
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
                  colSpan={7}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No computers to show.
                </TableCell>
              </TableRow>
            ) : (
              view.map((r) => (
                <TableRow key={r.tag}>
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
    </div>
  );
}
