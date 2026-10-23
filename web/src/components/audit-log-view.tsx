"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, Download, ScrollText } from "lucide-react";

import { fmtDateTime } from "@/components/detail-ui";
import { HeroHeader } from "@/components/hero-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditKpis, AuditListItem } from "@/db/computer-audit";
import { AUDIT_ACTIONS } from "@/lib/computer-audit-actions";
import { cn } from "@/lib/utils";

/**
 * Fleet audit log (computer audit spec). The server loads one time/location
 * window (default last 30 days). Asset, action, and operator narrow that
 * window in the browser, and Export CSV downloads those filtered rows.
 */

const PAGE_SIZE = 50;

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-44";

export type AuditRange = "today" | "7" | "30" | "90";

export type AuditLogFilters = {
  asset: string;
  action: string;
  operator: string;
  range: AuditRange;
  locationId: string;
};

export type AuditLocationChoice = {
  id: string;
  path: string;
};

const ACTION_LABEL: Record<string, string> = {
  software_deploy: "Software deploy",
  app_upgrade: "App upgrade",
  os_patch_install: "OS patch",
  missing_update_check: "Update check",
  reboot: "Reboot",
  reboot_schedule: "Reboot schedule",
  script_run: "Script",
  remote_session: "Remote session",
  assignment_change: "Assignment change",
  asset_update: "Asset update",
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/[_-]+/g, " ");
}

function sourceLabel(source: string): string {
  if (source === "admin_console") return "Admin Console";
  if (source === "scheduled") return "Automated Policy Engine";
  if (source === "collector") return "Collector";
  return source.replace(/[_-]+/g, " ");
}

function statusLabel(status: string): string {
  if (status === "succeeded") return "Success";
  if (status === "failed") return "Failed";
  if (status === "pending") return "Pending";
  if (status === "canceled") return "Canceled";
  return status;
}

function statusClass(status: string): string {
  if (status === "succeeded") {
    return "border-positive/30 bg-positive/10 text-positive";
  }
  if (status === "failed") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (status === "pending") {
    return "border-status-maintenance/30 bg-status-maintenance/10 text-status-maintenance";
  }
  return "border-border bg-muted text-muted-foreground";
}

function detailLabel(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatDetailValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function auditRowsToCsv(rows: AuditListItem[]): string {
  const headers = [
    "Time",
    "Asset",
    "Serial",
    "Action",
    "Operator",
    "Source",
    "Status",
    "Details",
  ];
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.occurredAtIso,
        row.assetTag,
        row.serial ?? "",
        actionLabel(row.action),
        row.operator,
        sourceLabel(row.source),
        statusLabel(row.status),
        row.summary,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

function rememberFilters(next: {
  asset: string;
  action: string;
  operator: string;
}) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(next)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const qs = params.toString();
  const path = window.location.pathname;
  window.history.replaceState(null, "", qs ? `${path}?${qs}` : path);
}

function KpiCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "danger";
}) {
  return (
    <Card className="gap-1 p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-2xl font-extrabold tracking-tight tabular-nums",
          tone === "danger" ? "text-destructive" : "text-foreground",
        )}
      >
        {value.toLocaleString()}
      </span>
    </Card>
  );
}

export function AuditLogView({
  events,
  kpis,
  locations,
  filters,
}: {
  events: AuditListItem[];
  kpis: AuditKpis;
  locations: AuditLocationChoice[];
  filters: AuditLogFilters;
}) {
  const [asset, setAsset] = React.useState(filters.asset);
  const [action, setAction] = React.useState(filters.action);
  const [operator, setOperator] = React.useState(filters.operator);
  const [page, setPage] = React.useState(0);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const assetOptions = React.useMemo(() => {
    const byTag = new Map<string, string>();
    for (const event of events) {
      if (!byTag.has(event.assetTag)) byTag.set(event.assetTag, event.assetName);
    }
    const options = [...byTag.entries()]
      .map(([tag, name]) => ({ tag, name }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    if (asset && !options.some((option) => option.tag === asset)) {
      options.unshift({ tag: asset, name: asset });
    }
    return options;
  }, [events, asset]);

  const actionOptions = React.useMemo(() => {
    const known = new Set<string>(AUDIT_ACTIONS);
    const extra = [...new Set(events.map((event) => event.action))]
      .filter((value) => !known.has(value))
      .sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));
    const options = [...AUDIT_ACTIONS, ...extra];
    if (action && !options.includes(action)) options.unshift(action);
    return options;
  }, [events, action]);

  const operatorOptions = React.useMemo(() => {
    const options = [...new Set(events.map((event) => event.operator))].sort(
      (a, b) => a.localeCompare(b),
    );
    if (operator && !options.includes(operator)) options.unshift(operator);
    return options;
  }, [events, operator]);

  const filtered = React.useMemo(
    () =>
      events.filter((event) => {
        if (asset && event.assetTag !== asset) return false;
        if (action && event.action !== action) return false;
        if (operator && event.operator !== operator) return false;
        return true;
      }),
    [events, asset, action, operator],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  );

  const locationKnown = locations.some((loc) => loc.id === filters.locationId);

  function setFilter(key: "asset" | "action" | "operator", value: string) {
    const next = { asset, action, operator, [key]: value };
    setAsset(next.asset);
    setAction(next.action);
    setOperator(next.operator);
    setPage(0);
    setOpenId(null);
    rememberFilters(next);
  }

  function onWindowChange(event: React.ChangeEvent<HTMLSelectElement>) {
    event.currentTarget.form?.requestSubmit();
  }

  function exportCsv() {
    const csv = auditRowsToCsv(filtered);
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <HeroHeader
        title={
          <span className="inline-flex items-center gap-2">
            Audit log
            <Badge
              variant="secondary"
              className="h-5 px-1.5 text-[10px] font-semibold tracking-wider uppercase"
            >
              Activity
            </Badge>
          </span>
        }
        icon={<ScrollText />}
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={exportCsv}
            disabled={filtered.length === 0}
          >
            <Download /> Export CSV
          </Button>
        }
      />

      <form method="get" action="/audit" className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <select
          name="asset"
          aria-label="Asset"
          className={selectClass}
          value={asset}
          onChange={(event) => setFilter("asset", event.target.value)}
        >
          <option value="">All assets</option>
          {assetOptions.map((option) => (
            <option key={option.tag} value={option.tag}>
              {option.name && option.name !== option.tag
                ? `${option.tag} — ${option.name}`
                : option.tag}
            </option>
          ))}
        </select>
        <select
          name="action"
          aria-label="Action"
          className={selectClass}
          value={action}
          onChange={(event) => setFilter("action", event.target.value)}
        >
          <option value="">All actions</option>
          {actionOptions.map((value) => (
            <option key={value} value={value}>
              {actionLabel(value)}
            </option>
          ))}
        </select>
        <select
          name="operator"
          aria-label="Operator"
          className={selectClass}
          value={operator}
          onChange={(event) => setFilter("operator", event.target.value)}
        >
          <option value="">All operators</option>
          {operatorOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          name="range"
          aria-label="Time range"
          className={cn(selectClass, "sm:w-40")}
          defaultValue={filters.range}
          onChange={onWindowChange}
        >
          <option value="today">Today</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
        <select
          name="loc"
          aria-label="Location"
          className={cn(selectClass, "sm:w-52")}
          defaultValue={filters.locationId}
          onChange={onWindowChange}
        >
          <option value="">All locations</option>
          {filters.locationId && !locationKnown && (
            <option value={filters.locationId}>Selected location</option>
          )}
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.path}
            </option>
          ))}
        </select>
        </div>
        <button type="submit" className="sr-only">
          Apply filters
        </button>
      </form>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Total events" value={kpis.total} />
        <KpiCard label="Actions today" value={kpis.today} />
        <KpiCard label="Unique operators" value={kpis.uniqueOperators} />
        <KpiCard label="Flagged" value={kpis.flagged} tone="danger" />
      </section>

      <Card className="gap-0 py-0">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Activity log</h2>
          <span className="text-xs text-muted-foreground tabular-nums">
            {filtered.length.toLocaleString()}{" "}
            {filtered.length === 1 ? "event" : "events"}
          </span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead>Serial</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-10 text-center text-sm whitespace-normal text-muted-foreground"
                >
                  {events.length === 0
                    ? "No audit events in this window."
                    : "No audit events match these filters."}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((event) => {
                const detailEntries = Object.entries(event.details);
                const open = openId === event.id;
                const detailsId = `audit-details-${event.id}`;
                return (
                  <React.Fragment key={event.id}>
                    <TableRow>
                      <TableCell className="text-muted-foreground">
                        {fmtDateTime(event.occurredAtIso)}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/assets/${encodeURIComponent(event.assetTag)}`}
                          className="font-medium text-primary hover:underline"
                          title={
                            event.assetName !== event.assetTag
                              ? event.assetName
                              : undefined
                          }
                        >
                          {event.assetTag}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {event.serial || "—"}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center rounded-4xl border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          {actionLabel(event.action)}
                        </span>
                      </TableCell>
                      <TableCell>{event.operator}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {sourceLabel(event.source)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-4xl border px-2 py-0.5 text-xs font-medium",
                            statusClass(event.status),
                          )}
                        >
                          {statusLabel(event.status)}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-md whitespace-normal">
                        {detailEntries.length > 0 ? (
                          <button
                            type="button"
                            className="inline-flex items-start gap-1 text-left"
                            aria-expanded={open}
                            aria-controls={detailsId}
                            onClick={() => setOpenId(open ? null : event.id)}
                          >
                            <ChevronRight
                              className={cn(
                                "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                                open && "rotate-90",
                              )}
                            />
                            <span>{event.summary || "—"}</span>
                          </button>
                        ) : (
                          event.summary || "—"
                        )}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow>
                        <TableCell
                          id={detailsId}
                          colSpan={8}
                          className="whitespace-normal bg-muted/40"
                        >
                          <dl className="grid gap-3 py-1 sm:grid-cols-2 lg:grid-cols-3">
                            {detailEntries.map(([key, value]) => (
                              <div key={key} className="min-w-0">
                                <dt className="text-xs text-muted-foreground">
                                  {detailLabel(key)}
                                </dt>
                                <dd className="text-sm break-all">
                                  {formatDetailValue(value)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
        {pageCount > 1 && (
          <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              Page {safePage + 1} of {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
