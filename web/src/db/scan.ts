import "server-only";

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "./index";
import {
  assets,
  computerDetails,
  machines,
  networkDetails,
  printerDetails,
  scanJobs,
  scanWorkers,
  type ScanJobResult,
  type ScanJobRow,
} from "./schema";

/**
 * The manual scan queue (spec 12). The web app owns the queue; the collector
 * worker pulls work (claim) and pushes results (status), matching the outbound-
 * only ingest posture. Everything here is server-only.
 */

// A crashed worker can't reap its own job, so the reaper runs server-side on
// every claim poll: any job stuck in `claimed`/`running` past this window is
// returned to `pending`. Overridable via env; default 10 minutes.
export const STUCK_JOB_TIMEOUT_MS = Number(
  process.env.SCAN_STUCK_JOB_TIMEOUT_MS ?? 10 * 60 * 1000,
);

// If no worker has upserted a heartbeat within this window, pending jobs are
// shown as "waiting for collector" in the jobs view (AC-5).
export const WORKER_HEARTBEAT_WINDOW_MS = Number(
  process.env.SCAN_WORKER_HEARTBEAT_WINDOW_MS ?? 30 * 1000,
);

export type ClaimedJob = {
  id: string;
  targets: string[];
  workerId: string;
  claimedAt: string; // ISO; echoed back by the worker as the claim fence
};

/**
 * Reap stale claims, record the worker heartbeat, then atomically claim the
 * oldest pending job (AC-3, AC-4). The claim is a single UPDATE gated by
 * `FOR UPDATE SKIP LOCKED`, so two workers polling at once never take the same
 * job. `claimedAt` is set from an app-side timestamp (millisecond precision) so
 * it round-trips exactly and the later status fence can match it.
 */
export async function claimNextJob(
  workerId: string,
  version: string | null,
): Promise<ClaimedJob | null> {
  // Heartbeat first, so "waiting for collector" clears even on an empty poll.
  const now = new Date();
  await db
    .insert(scanWorkers)
    .values({ workerId, lastPolledAt: now, version })
    .onConflictDoUpdate({
      target: scanWorkers.workerId,
      set: { lastPolledAt: now, version },
    });

  // Reaper: return jobs stranded by a crashed/slow worker to the queue.
  // NOTE: a raw `sql` fragment runs through postgres-js's `unsafe` path, which
  // rejects a JS Date param — interpolate an ISO string, which Postgres casts to
  // timestamptz. (Drizzle-typed columns in `.set()` are serialized for us.)
  const cutoffIso = new Date(now.getTime() - STUCK_JOB_TIMEOUT_MS).toISOString();
  await db
    .update(scanJobs)
    .set({ status: "pending", workerId: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        inArray(scanJobs.status, ["claimed", "running"]),
        sql`coalesce(${scanJobs.startedAt}, ${scanJobs.claimedAt}) < ${cutoffIso}`,
      ),
    );

  const claimedAtIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE ${scanJobs}
    SET status = 'claimed',
        worker_id = ${workerId},
        claimed_at = ${claimedAtIso},
        updated_at = ${claimedAtIso}
    WHERE id = (
      SELECT id FROM ${scanJobs}
      WHERE status = 'pending'
      ORDER BY requested_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, targets, worker_id, claimed_at
  `)) as unknown as Array<{
    id: string;
    targets: string[];
    worker_id: string;
    claimed_at: Date | string;
  }>;

  const row = rows[0];
  if (!row) return null;
  const ca =
    row.claimed_at instanceof Date
      ? row.claimed_at
      : new Date(row.claimed_at);
  return {
    id: row.id,
    targets: Array.isArray(row.targets) ? row.targets : [],
    workerId: row.worker_id,
    claimedAt: ca.toISOString(),
  };
}

export type StatusUpdate = {
  workerId: string;
  claimedAt: string; // the ISO value handed to the worker at claim time
  status: "running" | "succeeded" | "failed";
  result?: ScanJobResult;
  runId?: string;
  error?: string;
};

export type StatusOutcome = "ok" | "notfound" | "stale";

/**
 * Apply a worker's status update, fenced by the claim (AC-3, AC-4). The update
 * only lands when the caller's `workerId` and `claimedAt` still match the row's
 * current claim and the job is still `claimed`/`running`; otherwise it is a
 * stale claim (the reaper reclaimed it, or another worker re-ran it) and we
 * reject with `stale` so the newer result stands.
 */
export async function updateJobStatus(
  jobId: string,
  u: StatusUpdate,
): Promise<StatusOutcome> {
  const now = new Date();
  const claimedAt = new Date(u.claimedAt);

  const set: Partial<typeof scanJobs.$inferInsert> = {
    status: u.status,
    updatedAt: now,
  };
  if (u.status === "running") {
    set.startedAt = now;
  } else {
    set.finishedAt = now;
    if (u.status === "succeeded") {
      if (u.result) set.result = u.result;
      if (u.runId) set.runId = u.runId;
    }
    if (u.status === "failed" && u.error) set.error = u.error;
  }

  const updated = await db
    .update(scanJobs)
    .set(set)
    .where(
      and(
        eq(scanJobs.id, jobId),
        eq(scanJobs.workerId, u.workerId),
        eq(scanJobs.claimedAt, claimedAt),
        inArray(scanJobs.status, ["claimed", "running"]),
      ),
    )
    .returning({ id: scanJobs.id });

  if (updated.length) return "ok";

  // Distinguish a missing job from a stale/lost claim for the right HTTP code.
  const exists = await db
    .select({ id: scanJobs.id })
    .from(scanJobs)
    .where(eq(scanJobs.id, jobId))
    .limit(1);
  return exists.length ? "stale" : "notfound";
}

/**
 * Enqueue a scan job with a frozen, de-duplicated target list (AC-1, AC-2). The
 * caller resolves ids to IPs first; an empty list is rejected upstream (422).
 */
export async function enqueueScan(input: {
  scope: "all" | "selected";
  targets: string[];
  requestedBy: string;
}): Promise<string> {
  const [row] = await db
    .insert(scanJobs)
    .values({
      scope: input.scope,
      targets: input.targets,
      requestedBy: input.requestedBy,
    })
    .returning({ id: scanJobs.id });
  return row.id;
}

/** Cancel a still-pending job (AC-4 UI). Returns false if it isn't pending. */
export async function cancelPendingJob(jobId: string): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(scanJobs)
    .set({ status: "canceled", finishedAt: now, updatedAt: now })
    .where(and(eq(scanJobs.id, jobId), eq(scanJobs.status, "pending")))
    .returning({ id: scanJobs.id });
  return updated.length > 0;
}

/** De-duplicate, drop blanks, and trim a list of candidate IP strings. */
function dedupeIps(ips: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ips) {
    const ip = (raw ?? "").trim();
    if (ip && !seen.has(ip)) {
      seen.add(ip);
      out.push(ip);
    }
  }
  return out;
}

/**
 * The "all" device set snapshotted at enqueue time (AC-2): every known machine
 * IP unioned with every manually-entered printer's IP. `printer_details.ipAddress`
 * is the printer's source of truth, so a printer's IP wins over a stale
 * `machines.ip` for the same device (dedupe on the string handles the overlap).
 */
export async function resolveAllTargets(): Promise<string[]> {
  const machineIps = await db
    .select({ ip: machines.ip })
    .from(machines)
    .where(isNotNull(machines.ip));
  const printerIps = await db
    .select({ ip: printerDetails.ipAddress })
    .from(printerDetails);
  // Manually-entered computer target IPs, so an all-scan reaches computers the
  // collector hasn't discovered yet (spec 12 computer-IP addition).
  const computerIps = await db
    .select({ ip: computerDetails.ipAddress })
    .from(computerDetails)
    .where(isNotNull(computerDetails.ipAddress));
  // Detail-table IPs first so their canonical IP is the kept one on any overlap.
  return dedupeIps([
    ...printerIps.map((r) => r.ip),
    ...computerIps.map((r) => r.ip),
    ...machineIps.map((r) => r.ip),
  ]);
}

/**
 * Resolve selected asset tags to their scan IPs (AC-1, AC-2). The UI's asset
 * "id" is the human tag (e.g. OPUS-COMP-7491), not the uuid PK, so we match on
 * `assets.tag`. Per asset, the printer/network/computer detail IP wins over the
 * linked machine's IP; an asset with no resolvable IP is dropped. The caller
 * returns 422 if that leaves the list empty.
 */
export async function resolveAssetTargets(
  tags: string[],
): Promise<string[]> {
  if (tags.length === 0) return [];
  const rows = await db
    .select({
      printerIp: printerDetails.ipAddress,
      networkIp: networkDetails.ipAddress,
      computerIp: computerDetails.ipAddress,
      machineIp: machines.ip,
    })
    .from(assets)
    .leftJoin(printerDetails, eq(printerDetails.assetId, assets.id))
    .leftJoin(networkDetails, eq(networkDetails.assetId, assets.id))
    .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
    .leftJoin(machines, eq(machines.assetId, assets.id))
    .where(inArray(assets.tag, tags));

  // A manual detail-table IP is the source of truth; fall back to the IP the
  // collector discovered for the linked machine.
  return dedupeIps(
    rows.map(
      (r) => r.printerIp ?? r.networkIp ?? r.computerIp ?? r.machineIp,
    ),
  );
}

export type ScanJobListItem = {
  id: string;
  scope: "all" | "selected";
  status: ScanJobRow["status"];
  targetCount: number;
  result: ScanJobResult | null;
  requestedBy: string;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
  // Derived for the UI: a pending job with no live worker heartbeat.
  waitingForCollector: boolean;
};

/** List scan jobs newest first for the jobs view (AC-5). */
export async function listScanJobs(limit = 50): Promise<ScanJobListItem[]> {
  const rows = await db
    .select()
    .from(scanJobs)
    .orderBy(desc(scanJobs.requestedAt))
    .limit(limit);

  const workerLive = await isWorkerLive();

  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    status: r.status,
    targetCount: Array.isArray(r.targets) ? r.targets.length : 0,
    result: r.result ?? null,
    requestedBy: r.requestedBy,
    error: r.error,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    waitingForCollector: r.status === "pending" && !workerLive,
  }));
}

/** True when any worker has polled within the heartbeat window (AC-5). */
export async function isWorkerLive(): Promise<boolean> {
  const cutoffIso = new Date(Date.now() - WORKER_HEARTBEAT_WINDOW_MS).toISOString();
  const live = await db
    .select({ workerId: scanWorkers.workerId })
    .from(scanWorkers)
    .where(sql`${scanWorkers.lastPolledAt} >= ${cutoffIso}`)
    .limit(1);
  return live.length > 0;
}
