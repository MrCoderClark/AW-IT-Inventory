import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { updateAuditEventStatus, upsertAuditEvent } from "./computer-audit";
import { db } from "./index";
import { notifyRebootResult } from "./notifications";
import { isWorkerLive } from "./scan";
import { assets, patchInstallJobs, rebootJobs, type RebootJobRow } from "./schema";

/**
 * Scheduled reboot queue (spec 31 v2). Claim / fenced status / reaper mirror patch-install.
 */

export const REBOOT_STUCK_JOB_TIMEOUT_MS = Number(
  process.env.REBOOT_STUCK_JOB_TIMEOUT_MS ?? 10 * 60 * 1000,
);

const PAST_SCHEDULE_TOLERANCE_MS = 60_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IN_FLIGHT = ["pending", "claimed", "running"] as const;

const REBOOT_AUDIT_TABLE = "reboot_jobs";

function rebootAuditSummary(input: {
  sourceScheduleId?: string | null;
  sourcePatchInstallJobId?: string | null;
}): string {
  if (input.sourceScheduleId) return "Scheduled reboot";
  if (input.sourcePatchInstallJobId) return "Reboot after install";
  return "Forced reboot";
}

/** Scheduled occurrences keep the schedule owner when one was stored. */
function rebootAuditOperator(input: {
  sourceScheduleId?: string | null;
  requestedBy: string;
}): string {
  if (!input.sourceScheduleId) return input.requestedBy;
  const owner = input.requestedBy.trim();
  return owner || "system";
}

async function auditRebootTerminal(
  jobId: string,
  status: "succeeded" | "failed" | "canceled",
): Promise<void> {
  await updateAuditEventStatus({
    sourceTable: REBOOT_AUDIT_TABLE,
    sourceId: jobId,
    status,
  });
}

export type EnqueueRebootResult =
  | { ok: true; id: string }
  | { ok: false; reason: "already-inflight" | "past-schedule" };

export async function enqueueRebootJob(input: {
  assetId: string;
  targetIp: string;
  scheduledAt: Date;
  requestedBy: string;
  sourcePatchInstallJobId?: string | null;
  sourceScheduleId?: string | null;
}): Promise<EnqueueRebootResult> {
  const cutoff = Date.now() - PAST_SCHEDULE_TOLERANCE_MS;
  if (input.scheduledAt.getTime() < cutoff) {
    return { ok: false, reason: "past-schedule" };
  }

  const [inflight] = await db
    .select({ id: rebootJobs.id })
    .from(rebootJobs)
    .where(
      and(
        eq(rebootJobs.assetId, input.assetId),
        inArray(rebootJobs.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inflight) return { ok: false, reason: "already-inflight" };

  const [row] = await db
    .insert(rebootJobs)
    .values({
      assetId: input.assetId,
      targetIp: input.targetIp,
      scheduledAt: input.scheduledAt,
      requestedBy: input.requestedBy,
      sourcePatchInstallJobId: input.sourcePatchInstallJobId ?? null,
      sourceScheduleId: input.sourceScheduleId ?? null,
    })
    .returning({ id: rebootJobs.id });
  const scheduled = Boolean(input.sourceScheduleId);
  await upsertAuditEvent({
    sourceTable: REBOOT_AUDIT_TABLE,
    sourceId: row.id,
    assetId: input.assetId,
    action: "reboot",
    operator: rebootAuditOperator(input),
    source: scheduled ? "scheduled" : "admin_console",
    summary: rebootAuditSummary(input),
    details: {
      scheduledAt: input.scheduledAt.toISOString(),
      sourceScheduleId: input.sourceScheduleId ?? null,
      sourcePatchInstallJobId: input.sourcePatchInstallJobId ?? null,
    },
    status: "pending",
  });
  return { ok: true, id: row.id };
}

export type ClaimedReboot = {
  id: string;
  assetTag: string | null;
  targetIp: string;
  scheduledAt: string;
  sourcePatchInstallJobId: string | null;
  workerId: string;
  claimedAt: string;
};

export async function claimNextReboot(
  workerId: string,
): Promise<ClaimedReboot | null> {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - REBOOT_STUCK_JOB_TIMEOUT_MS,
  ).toISOString();

  await db
    .update(rebootJobs)
    .set({ status: "pending", workerId: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        inArray(rebootJobs.status, ["claimed", "running"]),
        sql`coalesce(${rebootJobs.startedAt}, ${rebootJobs.claimedAt}) < ${cutoffIso}`,
      ),
    );

  const claimedAtIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE ${rebootJobs}
    SET status = 'claimed',
        worker_id = ${workerId},
        claimed_at = ${claimedAtIso},
        updated_at = ${claimedAtIso}
    WHERE id = (
      SELECT r.id FROM ${rebootJobs} r
      LEFT JOIN ${patchInstallJobs} p ON p.id = r.source_patch_install_job_id
      WHERE r.status = 'pending'
        AND r.scheduled_at <= now()
        AND (r.source_patch_install_job_id IS NULL OR p.status = 'succeeded')
      ORDER BY r.scheduled_at
      LIMIT 1
      FOR UPDATE OF r SKIP LOCKED
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  const id = rows[0]?.id;
  if (!id) return null;

  const [job] = await db
    .select({
      id: rebootJobs.id,
      assetTag: assets.tag,
      targetIp: rebootJobs.targetIp,
      scheduledAt: rebootJobs.scheduledAt,
      sourcePatchInstallJobId: rebootJobs.sourcePatchInstallJobId,
      claimedAt: rebootJobs.claimedAt,
    })
    .from(rebootJobs)
    .leftJoin(assets, eq(assets.id, rebootJobs.assetId))
    .where(eq(rebootJobs.id, id))
    .limit(1);

  if (!job || !job.claimedAt) return null;
  return {
    id: job.id,
    assetTag: job.assetTag,
    targetIp: job.targetIp,
    scheduledAt: job.scheduledAt.toISOString(),
    sourcePatchInstallJobId: job.sourcePatchInstallJobId,
    workerId,
    claimedAt: job.claimedAt.toISOString(),
  };
}

export type StatusOutcome = "ok" | "notfound" | "stale";

export type RebootStatusUpdate = {
  workerId: string;
  claimedAt: string;
  status: "running" | "succeeded" | "failed";
  result?: Record<string, unknown>;
  error?: string;
};

export async function updateRebootStatus(
  jobId: string,
  u: RebootStatusUpdate,
): Promise<StatusOutcome> {
  if (!UUID_RE.test(jobId)) return "notfound";
  const now = new Date();
  const claimedAt = new Date(u.claimedAt);

  const set: Partial<typeof rebootJobs.$inferInsert> = {
    status: u.status,
    updatedAt: now,
  };
  if (u.status === "running") {
    set.startedAt = now;
  } else {
    set.finishedAt = now;
    if (u.result) set.result = u.result;
    if (u.status === "failed" && u.error) set.error = u.error;
  }

  const updated = await db
    .update(rebootJobs)
    .set(set)
    .where(
      and(
        eq(rebootJobs.id, jobId),
        eq(rebootJobs.workerId, u.workerId),
        eq(rebootJobs.claimedAt, claimedAt),
        inArray(rebootJobs.status, ["claimed", "running"]),
      ),
    )
    .returning({
      id: rebootJobs.id,
      assetId: rebootJobs.assetId,
      requestedBy: rebootJobs.requestedBy,
      scheduledAt: rebootJobs.scheduledAt,
      sourceScheduleId: rebootJobs.sourceScheduleId,
    });

  if (updated.length) {
    const row = updated[0];
    if (u.status === "succeeded" || u.status === "failed") {
      await auditRebootTerminal(row.id, u.status);
      await notifyRebootResult({
        jobId: row.id,
        assetId: row.assetId,
        status: u.status,
        requestedBy: row.requestedBy,
        scheduledAtIso: row.scheduledAt.toISOString(),
        error: u.error ?? null,
      });
      if (row.sourceScheduleId) {
        const { onScheduleJobTerminal } = await import("./reboot-schedules");
        await onScheduleJobTerminal(jobId);
      }
    }
    return "ok";
  }

  const [exists] = await db
    .select({ id: rebootJobs.id })
    .from(rebootJobs)
    .where(eq(rebootJobs.id, jobId))
    .limit(1);
  return exists ? "stale" : "notfound";
}

export async function cancelRebootJob(jobId: string): Promise<boolean> {
  if (!UUID_RE.test(jobId)) return false;
  const now = new Date();
  const updated = await db
    .update(rebootJobs)
    .set({ status: "canceled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(rebootJobs.id, jobId),
        inArray(rebootJobs.status, [...IN_FLIGHT]),
      ),
    )
    .returning({
      id: rebootJobs.id,
      assetId: rebootJobs.assetId,
      requestedBy: rebootJobs.requestedBy,
      scheduledAt: rebootJobs.scheduledAt,
      sourceScheduleId: rebootJobs.sourceScheduleId,
    });
  if (updated.length) {
    const row = updated[0];
    await auditRebootTerminal(row.id, "canceled");
    await notifyRebootResult({
      jobId: row.id,
      assetId: row.assetId,
      status: "canceled",
      requestedBy: row.requestedBy,
      scheduledAtIso: row.scheduledAt.toISOString(),
    });
    if (row.sourceScheduleId) {
      const { onScheduleJobTerminal } = await import("./reboot-schedules");
      await onScheduleJobTerminal(jobId);
    }
    return true;
  }
  return false;
}

export async function syncLinkedRebootsForInstall(
  installJobId: string,
  installStatus: "succeeded" | "failed" | "canceled",
): Promise<void> {
  if (installStatus === "succeeded") return;
  const now = new Date();
  const canceled = await db
    .update(rebootJobs)
    .set({ status: "canceled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(rebootJobs.sourcePatchInstallJobId, installJobId),
        inArray(rebootJobs.status, [...IN_FLIGHT]),
      ),
    )
    .returning({
      id: rebootJobs.id,
      assetId: rebootJobs.assetId,
      requestedBy: rebootJobs.requestedBy,
      scheduledAt: rebootJobs.scheduledAt,
    });
  for (const row of canceled) {
    await auditRebootTerminal(row.id, "canceled");
    await notifyRebootResult({
      jobId: row.id,
      assetId: row.assetId,
      status: "canceled",
      requestedBy: row.requestedBy,
      scheduledAtIso: row.scheduledAt.toISOString(),
    });
  }
}

export type RebootListItem = {
  id: string;
  status: RebootJobRow["status"];
  scheduledAt: string;
  sourcePatchInstallJobId: string | null;
  /** True when this job was materialized from a recurring schedule. */
  fromSchedule: boolean;
  requestedBy: string;
  error: string | null;
  finishedAt: string | null;
  waitingForCollector: boolean;
};

export async function listRebootJobsForAssetTag(
  tag: string,
  limit = 20,
): Promise<RebootListItem[]> {
  const rows = await db
    .select({
      id: rebootJobs.id,
      status: rebootJobs.status,
      scheduledAt: rebootJobs.scheduledAt,
      sourcePatchInstallJobId: rebootJobs.sourcePatchInstallJobId,
      sourceScheduleId: rebootJobs.sourceScheduleId,
      requestedBy: rebootJobs.requestedBy,
      error: rebootJobs.error,
      finishedAt: rebootJobs.finishedAt,
    })
    .from(rebootJobs)
    .innerJoin(assets, eq(assets.id, rebootJobs.assetId))
    .where(eq(assets.tag, tag))
    .orderBy(desc(rebootJobs.scheduledAt))
    .limit(limit);

  const workerLive = await isWorkerLive();

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    scheduledAt: r.scheduledAt.toISOString(),
    sourcePatchInstallJobId: r.sourcePatchInstallJobId,
    fromSchedule: Boolean(r.sourceScheduleId),
    requestedBy: r.requestedBy,
    error: r.error,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    waitingForCollector: r.status === "pending" && !workerLive,
  }));
}
