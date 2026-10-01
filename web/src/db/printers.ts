import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "./index";
import { isDownFailures } from "./reachability";
import {
  assets,
  printerChecks,
  printerCounters,
  printerDetails,
  printerStatus,
} from "./schema";
import type {
  PrinterActivityEvent,
  PrinterNetworkHealth,
  PrinterProtocolCheck,
  ReachabilityState,
} from "@/lib/data";

/**
 * Printer detail read helpers (spec 17.03). Pure reads over the existing spec 12
 * reachability tables and spec 14 counter history: no new telemetry, no writes.
 * The Network Health card and the derived activity feed are reshaped from data
 * OPUS already stores. All server-only. Looked up by the human tag (the URL key).
 */

/** Resolve a printer tag to its internal id, or null when the tag is not a
   printer. Every helper here is scoped to printers. */
async function printerIdByTag(tag: string): Promise<string | null> {
  const [a] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.tag, tag), eq(assets.type, "Printer")))
    .limit(1);
  return a?.id ?? null;
}

function iso(v: Date | string | null): string | null {
  return v ? (typeof v === "string" ? v : v.toISOString()) : null;
}

/** The latest check for one method, mapped to a protocol row. SNMP latency is
   dropped to null because the collector never times SNMP (AC-3.5). */
async function latestProtocolCheck(
  assetId: string,
  method: "tcp" | "snmp",
): Promise<PrinterProtocolCheck | null> {
  const [row] = await db
    .select({
      reachable: printerChecks.reachable,
      latencyMs: printerChecks.latencyMs,
      checkedAt: printerChecks.checkedAt,
    })
    .from(printerChecks)
    .where(and(eq(printerChecks.assetId, assetId), eq(printerChecks.method, method)))
    .orderBy(desc(printerChecks.checkedAt))
    .limit(1);
  if (!row) return null;
  return {
    reachable: row.reachable,
    latencyMs: method === "snmp" ? null : row.latencyMs,
    checkedAt: row.checkedAt.toISOString(),
  };
}

/**
 * The Network Health card for one printer (AC-3.5): the reachable rollup, the
 * IP, and the latest TCP (with latency) and SNMP (time only, no latency) probes.
 * HTTP is not returned; the UI shows it as "not tracked". Returns null when the
 * tag is not a printer.
 */
export async function getPrinterNetworkHealth(
  tag: string,
): Promise<PrinterNetworkHealth | null> {
  const assetId = await printerIdByTag(tag);
  if (!assetId) return null;

  const [[statusRow], [detailRow], tcp, snmp] = await Promise.all([
    db
      .select({
        reachable: printerStatus.reachable,
        isDown: printerStatus.isDown,
        lastCheckedAt: printerStatus.lastCheckedAt,
      })
      .from(printerStatus)
      .where(eq(printerStatus.assetId, assetId))
      .limit(1),
    db
      .select({ ip: printerDetails.ipAddress })
      .from(printerDetails)
      .where(eq(printerDetails.assetId, assetId))
      .limit(1),
    latestProtocolCheck(assetId, "tcp"),
    latestProtocolCheck(assetId, "snmp"),
  ]);

  const state: ReachabilityState =
    !statusRow || statusRow.reachable === null
      ? "unknown"
      : statusRow.isDown
        ? "down"
        : "up";

  return {
    state,
    lastCheckedAt: iso(statusRow?.lastCheckedAt ?? null),
    ip: detailRow?.ip ?? null,
    tcp,
    snmp,
  };
}

/**
 * The derived activity feed for one printer (AC-3.6). Merges three event kinds,
 * newest first, all read-only:
 *  - Health Check: one per reachability check (straight read of `printer_checks`).
 *  - Counter Sync: one per counter snapshot (straight read of `printer_counters`).
 *  - Status Update: down/recovery flips, NOT stored anywhere, so they are
 *    reconstructed by replaying `printer_checks` through the shared `isDownFailures`
 *    rule (the same threshold `recordChecks` uses, so the two never drift).
 * `limit` bounds the returned rows; the replay runs over a recent window big
 * enough that the visible flips are accurate. Returns [] for a non-printer.
 */
export async function getPrinterActivity(
  tag: string,
  limit = 20,
): Promise<PrinterActivityEvent[]> {
  const assetId = await printerIdByTag(tag);
  if (!assetId) return [];

  // A window generous enough to catch the flips behind the rows we will show.
  const window = Math.max(limit * 4, 80);

  const [checkRows, counterRows] = await Promise.all([
    db
      .select({
        checkedAt: printerChecks.checkedAt,
        reachable: printerChecks.reachable,
        method: printerChecks.method,
      })
      .from(printerChecks)
      .where(eq(printerChecks.assetId, assetId))
      .orderBy(desc(printerChecks.checkedAt))
      .limit(window),
    db
      .select({
        readingDate: printerCounters.readingDate,
        totalPages: printerCounters.totalPages,
        lastReadAt: printerCounters.lastReadAt,
      })
      .from(printerCounters)
      .where(eq(printerCounters.assetId, assetId))
      .orderBy(desc(printerCounters.readingDate))
      .limit(limit),
  ]);

  const events: PrinterActivityEvent[] = [];

  // Health Check rows (straight read).
  for (const c of checkRows) {
    events.push({
      kind: "health-check",
      at: c.checkedAt.toISOString(),
      title: "Health Check",
      detail: c.reachable
        ? "All services reachable"
        : `${c.method.toUpperCase()} unreachable`,
      ok: c.reachable,
    });
  }

  // Counter Sync rows (straight read).
  for (const r of counterRows) {
    events.push({
      kind: "counter-sync",
      at: r.lastReadAt.toISOString(),
      title: "Counter Sync",
      detail: `Total: ${r.totalPages.toLocaleString("en-US")} pages`,
      ok: true,
    });
  }

  // Status Update rows (reconstructed). Replay oldest -> newest through the
  // shared down rule, emitting an event at each flip.
  const chrono = [...checkRows].reverse();
  let consecutiveFailures = 0;
  let down = false;
  for (const c of chrono) {
    consecutiveFailures = c.reachable ? 0 : consecutiveFailures + 1;
    const nowDown = isDownFailures(consecutiveFailures);
    if (nowDown !== down) {
      events.push({
        kind: "status-update",
        at: c.checkedAt.toISOString(),
        title: "Status Update",
        detail: nowDown ? "Printer went offline" : "Printer ready",
        ok: !nowDown,
      });
      down = nowDown;
    }
  }

  // Merge newest first, cap at the requested size.
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, limit);
}
