import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "./index";
import { isWorkerLive } from "./scan";
import { resolveDeployTarget } from "./software-deploy";
import {
  assets,
  missingUpdateChecks,
  windowsUpdateState,
  type MissingUpdateCheckRow,
} from "./schema";

/**
 * One-host missing-update Search queue (spec 31 phase 4, AC-21).
 */

export const MISSING_CHECK_STUCK_TIMEOUT_MS = Number(
  process.env.MISSING_UPDATE_CHECK_STUCK_JOB_TIMEOUT_MS ?? 15 * 60 * 1000,
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IN_FLIGHT = ["pending", "claimed", "running"] as const;

export { resolveDeployTarget };

export type EnqueueCheckResult =
  | { ok: true; id: string }
  | { ok: false; reason: "already-inflight" };

export async function enqueueMissingUpdateCheck(input: {
  assetId: string;
  targetIp: string;
  requestedBy: string;
}): Promise<EnqueueCheckResult> {
  const [inflight] = await db
    .select({ id: missingUpdateChecks.id })
    .from(missingUpdateChecks)
    .where(
      and(
        eq(missingUpdateChecks.assetId, input.assetId),
        inArray(missingUpdateChecks.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inflight) return { ok: false, reason: "already-inflight" };

  const [row] = await db
    .insert(missingUpdateChecks)
    .values({
      assetId: input.assetId,
      targetIp: input.targetIp,
      requestedBy: input.requestedBy,
    })
    .returning({ id: missingUpdateChecks.id });
  return { ok: true, id: row.id };
}

export type ClaimedMissingCheck = {
  id: string;
  assetId: string;
  assetTag: string | null;
  targetIp: string;
  workerId: string;
  claimedAt: string;
};

export async function claimNextMissingUpdateCheck(
  workerId: string,
): Promise<ClaimedMissingCheck | null> {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - MISSING_CHECK_STUCK_TIMEOUT_MS,
  ).toISOString();

  await db
    .update(missingUpdateChecks)
    .set({ status: "pending", workerId: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        inArray(missingUpdateChecks.status, ["claimed", "running"]),
        sql`coalesce(${missingUpdateChecks.startedAt}, ${missingUpdateChecks.claimedAt}) < ${cutoffIso}`,
      ),
    );

  const claimedAtIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE ${missingUpdateChecks}
    SET status = 'claimed',
        worker_id = ${workerId},
        claimed_at = ${claimedAtIso},
        updated_at = ${claimedAtIso}
    WHERE id = (
      SELECT id FROM ${missingUpdateChecks}
      WHERE status = 'pending'
      ORDER BY requested_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  const id = rows[0]?.id;
  if (!id) return null;

  const [job] = await db
    .select({
      id: missingUpdateChecks.id,
      assetId: missingUpdateChecks.assetId,
      assetTag: assets.tag,
      targetIp: missingUpdateChecks.targetIp,
      claimedAt: missingUpdateChecks.claimedAt,
    })
    .from(missingUpdateChecks)
    .leftJoin(assets, eq(assets.id, missingUpdateChecks.assetId))
    .where(eq(missingUpdateChecks.id, id))
    .limit(1);

  if (!job || !job.claimedAt) return null;
  return {
    id: job.id,
    assetId: job.assetId,
    assetTag: job.assetTag,
    targetIp: job.targetIp,
    workerId,
    claimedAt: job.claimedAt.toISOString(),
  };
}

export type StatusOutcome = "ok" | "notfound" | "stale";

export async function updateMissingUpdateCheckStatus(
  jobId: string,
  u: {
    workerId: string;
    claimedAt: string;
    status: "running" | "succeeded" | "failed";
    error?: string;
  },
): Promise<StatusOutcome> {
  if (!UUID_RE.test(jobId)) return "notfound";
  const now = new Date();
  const claimedAt = new Date(u.claimedAt);

  const set: Partial<typeof missingUpdateChecks.$inferInsert> = {
    status: u.status,
    updatedAt: now,
  };
  if (u.status === "running") set.startedAt = now;
  else {
    set.finishedAt = now;
    if (u.status === "failed" && u.error) set.error = u.error;
  }

  const updated = await db
    .update(missingUpdateChecks)
    .set(set)
    .where(
      and(
        eq(missingUpdateChecks.id, jobId),
        eq(missingUpdateChecks.workerId, u.workerId),
        eq(missingUpdateChecks.claimedAt, claimedAt),
        inArray(missingUpdateChecks.status, ["claimed", "running"]),
      ),
    )
    .returning({ id: missingUpdateChecks.id });

  if (updated.length) return "ok";

  const [exists] = await db
    .select({ id: missingUpdateChecks.id })
    .from(missingUpdateChecks)
    .where(eq(missingUpdateChecks.id, jobId))
    .limit(1);
  return exists ? "stale" : "notfound";
}

export async function cancelMissingUpdateCheck(jobId: string): Promise<boolean> {
  if (!UUID_RE.test(jobId)) return false;
  const now = new Date();
  const updated = await db
    .update(missingUpdateChecks)
    .set({ status: "canceled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(missingUpdateChecks.id, jobId),
        inArray(missingUpdateChecks.status, [...IN_FLIGHT]),
      ),
    )
    .returning({ id: missingUpdateChecks.id });
  return updated.length > 0;
}

export async function getMissingUpdateCheck(
  jobId: string,
): Promise<MissingUpdateCheckRow | null> {
  if (!UUID_RE.test(jobId)) return null;
  const [row] = await db
    .select()
    .from(missingUpdateChecks)
    .where(eq(missingUpdateChecks.id, jobId))
    .limit(1);
  return row ?? null;
}

export type MissingCheckListItem = {
  id: string;
  status: MissingUpdateCheckRow["status"];
  requestedBy: string;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
  waitingForCollector: boolean;
};

export async function listMissingUpdateChecksForAssetTag(
  tag: string,
  limit = 10,
): Promise<MissingCheckListItem[]> {
  const rows = await db
    .select({
      id: missingUpdateChecks.id,
      status: missingUpdateChecks.status,
      requestedBy: missingUpdateChecks.requestedBy,
      error: missingUpdateChecks.error,
      requestedAt: missingUpdateChecks.requestedAt,
      finishedAt: missingUpdateChecks.finishedAt,
    })
    .from(missingUpdateChecks)
    .innerJoin(assets, eq(assets.id, missingUpdateChecks.assetId))
    .where(eq(assets.tag, tag))
    .orderBy(desc(missingUpdateChecks.requestedAt))
    .limit(limit);

  const workerLive = await isWorkerLive();
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    requestedBy: r.requestedBy,
    error: r.error,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    waitingForCollector: r.status === "pending" && !workerLive,
  }));
}

/** Pending-reboot flags keyed by asset tag (Computers table badge, AC-22). */
export async function getPendingRebootMap(): Promise<Record<string, boolean>> {
  const rows = await db
    .select({
      tag: assets.tag,
      pendingReboot: windowsUpdateState.pendingReboot,
    })
    .from(windowsUpdateState)
    .innerJoin(assets, eq(assets.id, windowsUpdateState.assetId))
    .where(eq(windowsUpdateState.pendingReboot, true));
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.tag] = true;
  return out;
}
