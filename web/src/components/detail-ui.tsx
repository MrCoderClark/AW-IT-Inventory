import * as React from "react";

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
