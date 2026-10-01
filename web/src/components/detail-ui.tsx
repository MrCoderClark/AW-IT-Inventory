import * as React from "react";
import Link from "next/link";

import type { AssignmentEvent, MachineSummary } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the redesigned, tabbed asset detail pages (spec 17).
 * Extracted from the printer detail (child 03) so the computer detail (child 04)
 * and the thin categories (child 05) render the same cards, fields, and formatting.
 * Presentational and server-safe (no hooks, no client state).
 */

/* ---------------- formatting helpers ---------------- */

export function fmtDate(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function fmtDateTime(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDay(day: string | null | undefined) {
  if (!day) return "—";
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function fmtNumber(n: number | null | undefined) {
  return n == null ? "—" : n.toLocaleString("en-US");
}

/* ---------------- small presentational pieces ---------------- */

/** A card: a tinted icon tile, a title, an optional right-side action, content. */
export function Panel({
  icon,
  title,
  action,
  className,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col rounded-(--radius-card) bg-card p-5 ring-1 ring-foreground/10",
        className,
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-(--radius-control) bg-accent-soft text-primary [&_svg]:size-4"
          >
            {icon}
          </span>
          <h2 className="font-heading text-base font-semibold">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One labelled field with a muted leading icon (the Asset Information card). */
export function InfoField({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span aria-hidden className="mt-0.5 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className={cn("mt-0.5 truncate text-sm", mono && "font-mono text-[13px]")}>
          {value}
        </p>
      </div>
    </div>
  );
}

/** A "Label: value" line for status-style cards. */
export function StatusRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

/** A coloured dot + text, e.g. "● Online". */
export function Dot({
  color,
  children,
}: {
  color: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span style={{ color }}>{children}</span>
    </span>
  );
}

/* ---------------- activity feed (shared by the tabbed detail pages) ---------- */

/** A derived activity event (assignment history + the last scan). Newest first. */
export type ActivityEvent = {
  at: string;
  title: string;
  detail: string;
  ok: boolean;
};

/** Build an activity feed from a device's assignment history plus (optionally) its
   last collector scan. Thin categories pass no machine, so it's assignments only. */
export function deriveActivity(
  history: AssignmentEvent[],
  machine?: MachineSummary,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const e of history) {
    events.push({
      at: e.assignedAt,
      title: "Assigned",
      detail: `To ${e.personName} by ${e.assignedBy}`,
      ok: true,
    });
    if (e.unassignedAt) {
      events.push({
        at: e.unassignedAt,
        title: "Returned",
        detail: `From ${e.personName}${e.unassignedBy ? ` by ${e.unassignedBy}` : ""}`,
        ok: false,
      });
    }
  }
  if (machine?.lastSeen) {
    events.push({
      at: machine.lastSeen,
      title: "Scanned",
      detail: machine.status ? `Collector · ${machine.status}` : "Collector sweep",
      ok: true,
    });
  }
  return events.sort((a, b) => +new Date(b.at) - +new Date(a.at));
}

export function ActivityTable({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No activity yet. Assignments and collector scans appear here.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="pb-2 pr-4 font-semibold">Date &amp; Time</th>
            <th className="pb-2 pr-4 font-semibold">Event</th>
            <th className="pb-2 font-semibold">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {events.map((e, i) => (
            <tr key={`${e.title}-${e.at}-${i}`}>
              <td className="whitespace-nowrap py-2.5 pr-4 text-muted-foreground tabular-nums">
                {fmtDateTime(e.at)}
              </td>
              <td className="whitespace-nowrap py-2.5 pr-4 font-medium">{e.title}</td>
              <td className="py-2.5">
                <Dot color={e.ok ? "var(--status-online)" : "var(--muted-foreground)"}>
                  {e.detail}
                </Dot>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The device's custody history (spec 16, AC-7), newest first. */
export function AssignmentTimeline({ history }: { history: AssignmentEvent[] }) {
  if (history.length === 0) {
    return (
      <p className="rounded-xl border border-dashed bg-card/50 p-5 text-sm text-muted-foreground">
        No assignment history yet.
      </p>
    );
  }
  return (
    <ol className="relative ml-1 border-l pl-5">
      {history.map((e) => (
        <li key={e.id} className="relative pb-5 last:pb-0">
          <span
            className={cn(
              "absolute -left-[23px] top-1 size-2.5 rounded-full border-2 bg-card",
              e.open ? "border-primary" : "border-border",
            )}
          />
          <p className="text-sm">
            <Link href={`/people/${e.personId}`} className="font-medium hover:underline">
              {e.personName}
            </Link>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Assigned {fmtDateTime(e.assignedAt)} by {e.assignedBy}
          </p>
          {e.open ? (
            <p className="mt-0.5 text-xs text-[color:var(--status-online)]">
              Currently held
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Returned {fmtDateTime(e.unassignedAt)} by {e.unassignedBy}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
