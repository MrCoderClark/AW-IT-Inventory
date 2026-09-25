import "server-only";

import { and, desc, eq, lt, sql } from "drizzle-orm";

import { db } from "./index";
import { getLocationPathMap } from "./queries";
import { assets, printerCounters, printerDetails } from "./schema";
import type { CounterHistoryDay, PrinterCounters } from "@/lib/data";

export type { CounterHistoryDay, PrinterCounters };

/**
 * Printer page counter history (spec 14). A printer's total page (life) counter
 * already rides the ingest inside `machines.printer` (`page_count`); this module
 * owns the durable, day-indexed history that a day-over-day delta needs. One row
 * per printer per calendar day (`printer_counters`), the latest read of the day
 * winning, so recording is idempotent within a day.
 *
 * Everything is computed from this history: the latest total, the delta, the
 * detail-page panel and the daily report all read here (no rollup table). This
 * live meter is a printer's only page count (the manual `pageCount` was removed).
 */

/** One printer's line in the daily counter report / email. */
export interface CounterReportRow {
  name: string;
  serial: string | null;
  location: string | null; // full location path, e.g. "3rd Floor / Back Cubicles"
  ip: string;
  total: number | null; // the target day's total, or last known when no reading
  delta: number | null; // pages that day; null with a note
  note: "first reading" | "counter reset" | "no reading" | null;
}

/** Today's calendar date (YYYY-MM-DD) in the server's local zone, which the
 *  on-prem web and collector share. Used as the snapshot key. */
export function todayLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Record today's counter snapshot for a printer (AC-2). Idempotent per day: the
 * latest read of the day wins, so a second scan the same day updates the one row
 * instead of inserting a duplicate. Called from the ingest for a matched printer
 * that returned a numeric counter.
 */
export async function upsertPrinterCounter(
  assetId: string,
  totalPages: number,
  source: "scheduled" | "manual" = "scheduled",
  when: Date = new Date(),
): Promise<void> {
  const readingDate = todayLocalDate(when);
  await db
    .insert(printerCounters)
    .values({ assetId, readingDate, totalPages, source, lastReadAt: when })
    .onConflictDoUpdate({
      target: [printerCounters.assetId, printerCounters.readingDate],
      set: { totalPages, source, lastReadAt: when, updatedAt: when },
    });
}

/** Turn a day-over-day difference into a delta + note per the spec rule: a
 *  first reading has no prior, a drop is a counter reset, never a negative. */
function deltaOf(
  total: number,
  prior: number | null,
): { delta: number | null; note: CounterHistoryDay["note"] } {
  if (prior === null) return { delta: null, note: "first-reading" };
  const diff = total - prior;
  if (diff < 0) return { delta: null, note: "counter-reset" };
  return { delta: diff, note: null };
}

/**
 * The counter panel for one printer's detail page (AC-3): latest total, today's
 * delta, and recent daily history with per-day deltas. `tag` is the human asset
 * id. Returns null when the tag is not a printer; empty history until the first
 * reading lands. Fetches one extra prior day so the oldest shown day still gets
 * a real delta.
 */
export async function getPrinterCounters(
  tag: string,
  historyLimit = 14,
): Promise<PrinterCounters | null> {
  const [a] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.tag, tag), eq(assets.type, "Printer")))
    .limit(1);
  if (!a) return null;

  const rows = await db
    .select({
      readingDate: printerCounters.readingDate,
      totalPages: printerCounters.totalPages,
    })
    .from(printerCounters)
    .where(eq(printerCounters.assetId, a.id))
    .orderBy(desc(printerCounters.readingDate))
    .limit(historyLimit + 1);

  const empty: PrinterCounters = {
    latestTotal: null,
    latestDate: null,
    latestDelta: null,
    latestNote: null,
    history: [],
  };
  if (rows.length === 0) return empty;

  // rows are newest-first; each day's prior is the next row down.
  const history: CounterHistoryDay[] = [];
  for (let i = 0; i < Math.min(rows.length, historyLimit); i++) {
    const total = rows[i].totalPages;
    const prior = i + 1 < rows.length ? rows[i + 1].totalPages : null;
    const { delta, note } = deltaOf(total, prior);
    history.push({ readingDate: rows[i].readingDate, totalPages: total, delta, note });
  }

  const latest = history[0];
  return {
    latestTotal: latest.totalPages,
    latestDate: latest.readingDate,
    latestDelta: latest.delta,
    latestNote: latest.note,
    history,
  };
}

/**
 * Assemble one report row per managed printer for the daily email (AC-4): its
 * target-day total and that day's delta. Every printer is listed; one with no
 * reading for the target day is "no reading", never dropped. `targetDate`
 * defaults to today.
 */
export async function assembleCounterReport(
  targetDate: string = todayLocalDate(),
): Promise<CounterReportRow[]> {
  const [printers, pathById] = await Promise.all([
    db
      .select({
        assetId: printerDetails.assetId,
        name: assets.name,
        serial: assets.serial,
        locationId: assets.locationId,
        ip: printerDetails.ipAddress,
      })
      .from(printerDetails)
      .innerJoin(assets, eq(assets.id, printerDetails.assetId))
      .where(eq(assets.type, "Printer")),
    getLocationPathMap(),
  ]);

  const rows: CounterReportRow[] = [];
  for (const p of printers) {
    if (!p.ip || !p.ip.trim()) continue;
    const location = p.locationId ? pathById.get(p.locationId) ?? null : null;

    const [today] = await db
      .select({ totalPages: printerCounters.totalPages })
      .from(printerCounters)
      .where(
        and(
          eq(printerCounters.assetId, p.assetId),
          eq(printerCounters.readingDate, targetDate),
        ),
      )
      .limit(1);

    const [prior] = await db
      .select({ totalPages: printerCounters.totalPages })
      .from(printerCounters)
      .where(
        and(
          eq(printerCounters.assetId, p.assetId),
          lt(printerCounters.readingDate, targetDate),
        ),
      )
      .orderBy(desc(printerCounters.readingDate))
      .limit(1);

    if (!today) {
      // No reading for the target day; still list it, showing the last known
      // total for context.
      rows.push({
        name: p.name,
        serial: p.serial,
        location,
        ip: p.ip,
        total: prior?.totalPages ?? null,
        delta: null,
        note: "no reading",
      });
      continue;
    }

    const { delta, note } = deltaOf(today.totalPages, prior?.totalPages ?? null);
    rows.push({
      name: p.name,
      serial: p.serial,
      location,
      ip: p.ip,
      total: today.totalPages,
      delta,
      note:
        note === "first-reading"
          ? "first reading"
          : note === "counter-reset"
            ? "counter reset"
            : null,
    });
  }

  // Stable, readable order for the email.
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

/**
 * Prune counter history older than the retention window (AC-6). Driven by the
 * worker's existing daily retention task, which passes its configured retention
 * in days. Compares on `reading_date` (a DATE column) against the cutoff day.
 */
export async function pruneCounters(retentionDays: number): Promise<number> {
  const days =
    Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 365;
  const cutoff = todayLocalDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  const deleted = await db
    .delete(printerCounters)
    .where(sql`${printerCounters.readingDate} < ${cutoff}`)
    .returning({ assetId: printerCounters.assetId });
  return deleted.length;
}
