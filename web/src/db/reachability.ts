import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { db } from "./index";
import {
  assets,
  printerChecks,
  printerDetails,
  printerStatus,
  type PrinterStatusRow,
} from "./schema";

/**
 * Printer reachability + alerting (spec 12, milestone 3). The collector worker
 * probes every manually-entered printer and posts the results here; this module
 * owns the reachability history (`printer_checks`), the current rollup and alert
 * state (`printer_status`), and the up/down transition detection that drives the
 * admin emails. Everything here is server-only.
 *
 * A printer is "down" exactly when it has failed 2 checks in a row
 * (`consecutiveFailures >= 2`, AC-7). Alert de-dupe rides `lastAlertState`: the
 * rollup is written in a transaction first, then the caller fires the email, and
 * `lastAlertState` is advanced only once the send succeeds (see
 * `markAlertSent`). A failed send therefore leaves the transition pending so the
 * next check retries it, while a succeeded send blocks any repeat — one down
 * email per episode, one recovery email per recovery.
 */

const DOWN_THRESHOLD = 2;

/** A printer the worker should probe: its asset id and current IP. */
export type PrinterTarget = { assetId: string; ipAddress: string };

/**
 * Every manually-entered printer to check (AC-6). A printer's IP is required in
 * `printer_details`, so any printer asset with a detail row is a target.
 */
export async function listPrinterTargets(): Promise<PrinterTarget[]> {
  const rows = await db
    .select({ assetId: printerDetails.assetId, ipAddress: printerDetails.ipAddress })
    .from(printerDetails)
    .innerJoin(assets, eq(assets.id, printerDetails.assetId))
    .where(eq(assets.type, "Printer"));
  return rows.filter((r) => r.ipAddress && r.ipAddress.trim().length > 0);
}

/** One reachability check posted by the worker (the IP is resolved server-side). */
export type IncomingCheck = {
  assetId: string;
  reachable: boolean;
  latencyMs?: number | null;
  method: "tcp" | "snmp";
  source: "scheduled" | "manual";
  checkedAt?: string | null; // ISO; defaults to now
};

/** An up/down transition the caller must email about, after the write commits. */
export type AlertEvent = {
  assetId: string;
  event: "down" | "up";
  name: string;
  ip: string;
  since: string | null; // downSince for a down alert; lastReachableAt-ish for recovery
};

/**
 * Record a batch of checks and return the alert transitions to fire (AC-6, AC-7,
 * AC-8 data). Each check writes its history row and updates the printer's rollup
 * in one transaction; the alert email is fired by the caller afterwards and only
 * then is `lastAlertState` advanced (via `markAlertSent`), so a failed send is
 * retried by the next check and a succeeded send never double-fires.
 */
export async function recordChecks(
  checks: IncomingCheck[],
): Promise<AlertEvent[]> {
  if (checks.length === 0) return [];

  // Resolve name + IP once for every asset in the batch (for the check-row IP
  // snapshot and the alert payload). Unknown asset ids are skipped.
  const assetIds = [...new Set(checks.map((c) => c.assetId))];
  const meta = await db
    .select({
      assetId: printerDetails.assetId,
      name: assets.name,
      ip: printerDetails.ipAddress,
    })
    .from(printerDetails)
    .innerJoin(assets, eq(assets.id, printerDetails.assetId))
    .where(inArray(printerDetails.assetId, assetIds));
  const metaById = new Map(meta.map((m) => [m.assetId, m]));

  const events: AlertEvent[] = [];

  for (const check of checks) {
    const info = metaById.get(check.assetId);
    if (!info) continue; // not a known printer; ignore rather than 500

    const checkedAt = check.checkedAt ? new Date(check.checkedAt) : new Date();
    if (Number.isNaN(checkedAt.getTime())) continue;

    const event = await db.transaction(async (tx) => {
      // History row (AC-8). The IP is snapshotted from the printer's current IP.
      await tx.insert(printerChecks).values({
        assetId: check.assetId,
        ipAddress: info.ip,
        checkedAt,
        reachable: check.reachable,
        latencyMs: check.latencyMs ?? null,
        method: check.method,
        source: check.source,
      });

      const [prev] = await tx
        .select()
        .from(printerStatus)
        .where(eq(printerStatus.assetId, check.assetId))
        .limit(1);

      const prevFailures = prev?.consecutiveFailures ?? 0;
      const prevAlert: PrinterStatusRow["lastAlertState"] =
        prev?.lastAlertState ?? "up";

      const consecutiveFailures = check.reachable ? 0 : prevFailures + 1;
      const isDown = consecutiveFailures >= DOWN_THRESHOLD;
      // downSince: stamped when the printer first crosses into `down`, held while
      // it stays down, cleared on any successful check.
      const downSince = !isDown
        ? null
        : prev?.isDown
          ? (prev.downSince ?? checkedAt)
          : checkedAt;

      const set = {
        reachable: check.reachable,
        lastCheckedAt: checkedAt,
        lastReachableAt: check.reachable ? checkedAt : (prev?.lastReachableAt ?? null),
        consecutiveFailures,
        isDown,
        downSince,
        updatedAt: new Date(),
      };

      if (prev) {
        await tx
          .update(printerStatus)
          .set(set)
          .where(eq(printerStatus.assetId, check.assetId));
      } else {
        await tx
          .insert(printerStatus)
          .values({ assetId: check.assetId, lastAlertState: "up", ...set });
      }

      // A pending transition is one the persisted alert state hasn't caught up
      // to yet. `lastAlertState` is NOT advanced here — the caller advances it
      // only after the email actually sends (retry-safe de-dupe).
      if (isDown && prevAlert === "up") {
        return {
          assetId: check.assetId,
          event: "down" as const,
          name: info.name,
          ip: info.ip,
          since: downSince ? downSince.toISOString() : null,
        };
      }
      if (!isDown && check.reachable && prevAlert === "down") {
        return {
          assetId: check.assetId,
          event: "up" as const,
          name: info.name,
          ip: info.ip,
          since: checkedAt.toISOString(),
        };
      }
      return null;
    });

    if (event) events.push(event);
  }

  return events;
}

/**
 * Advance `lastAlertState` after an alert email has actually been sent, so the
 * transition isn't re-fired. Called only on a successful send; a failed send
 * leaves the state behind for the next check to retry.
 */
export async function markAlertSent(
  assetId: string,
  state: "up" | "down",
): Promise<void> {
  await db
    .update(printerStatus)
    .set({ lastAlertState: state, updatedAt: new Date() })
    .where(eq(printerStatus.assetId, assetId));
}

/**
 * Prune reachability history older than the retention window (AC-10). Driven by
 * the worker's daily task, which passes its configured retention in days.
 */
export async function pruneChecks(retentionDays: number): Promise<number> {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 365;
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  // A raw comparison (matches the timestamp-vs-ISO pattern in scan.ts): postgres
  // casts the ISO string to timestamptz.
  const deleted = await db
    .delete(printerChecks)
    .where(sql`${printerChecks.checkedAt} < ${cutoffIso}`)
    .returning({ id: printerChecks.id });
  return deleted.length;
}
