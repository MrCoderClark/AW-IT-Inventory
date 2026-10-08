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
import type { CheckId, CheckStatus } from "@/lib/compliance-score";

const STATUS_COLOR: Record<CheckStatus, string> = {
  pass: "var(--status-online)",
  warn: "var(--status-maintenance)",
  fail: "var(--status-down)",
  unknown: "var(--status-storage)",
};

const STATUS_WORD: Record<CheckStatus, string> = {
  pass: "OK",
  warn: "Warning",
  fail: "Fail",
  unknown: "Unknown",
};

export interface FleetRow {
  tag: string;
  name: string;
  score: number | null; // null = not assessed
  assessed: boolean;
  checks: { id: CheckId; label: string; status: CheckStatus }[];
}

function scoreColor(score: number): string {
  if (score >= 80) return "var(--status-online)";
  if (score >= 50) return "var(--status-maintenance)";
  return "var(--status-down)";
}

/** Sort key: not-assessed first (need attention), then by score ascending. */
function sortKey(r: FleetRow): number {
  return r.score == null ? -1 : r.score;
}

export function ComplianceFleet({ rows }: { rows: FleetRow[] }) {
  const [desc, setDesc] = React.useState(false); // default: worst first
  const [nonCompliantOnly, setNonCompliantOnly] = React.useState(false);

  const view = React.useMemo(() => {
    let r = rows;
    if (nonCompliantOnly) r = r.filter((x) => !x.assessed || (x.score ?? 0) < 100);
    return [...r].sort((a, b) =>
      desc ? sortKey(b) - sortKey(a) : sortKey(a) - sortKey(b),
    );
  }, [rows, desc, nonCompliantOnly]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant={nonCompliantOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setNonCompliantOnly((v) => !v)}
        >
          {nonCompliantOnly ? "Showing non-compliant" : "Show non-compliant only"}
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
              <TableHead className="w-28">
                <button
                  type="button"
                  onClick={() => setDesc((v) => !v)}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  Score <ArrowDownUp className="size-3" />
                </button>
              </TableHead>
              <TableHead>Checks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
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
                  <TableCell>
                    {r.assessed && r.score != null ? (
                      <span
                        className="text-lg font-semibold tabular-nums"
                        style={{ color: scoreColor(r.score) }}
                      >
                        {r.score}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Not assessed
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      {r.checks.map((c) => (
                        <span
                          key={c.id}
                          title={`${c.label}: ${STATUS_WORD[c.status]}`}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                        >
                          <span
                            aria-hidden
                            className="size-2 rounded-full"
                            style={{ backgroundColor: STATUS_COLOR[c.status] }}
                          />
                          {c.label}
                        </span>
                      ))}
                    </div>
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
