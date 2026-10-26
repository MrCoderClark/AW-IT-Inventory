import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { updateAuditEventStatus, upsertAuditEvent } from "./computer-audit";
import { db } from "./index";
import { notifyScriptRunResult } from "./notifications";
import { isWorkerLive } from "./scan";
import { resolveDeployTarget } from "./software-deploy";
import {
  assets,
  scriptRunJobs,
  type ScriptRunJobRow,
  type ScriptRunResult,
  type ScriptSnapshot,
} from "./schema";

/** Script run queue (spec 32). */

export const SCRIPT_RUN_STUCK_TIMEOUT_MS = Number(
  process.env.SCRIPT_RUN_STUCK_JOB_TIMEOUT_MS ?? 15 * 60 * 1000,
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IN_FLIGHT = ["pending", "claimed", "running"] as const;

const SCRIPT_AUDIT_TABLE = "script_run_jobs";

function scriptRunSummary(name: string, exitCode?: number | null): string {
  if (exitCode == null) return `Run ${name}`;
  return `Ran ${name} (exit ${exitCode})`;
}

export { resolveDeployTarget };

export type EnqueueRunResult =
  | { ok: true; id: string }
  | { ok: false; reason: "already-inflight" };

export async function enqueueScriptRun(input: {
  assetId: string;
  targetIp: string;
  scriptId: string;
  scriptSnapshot: ScriptSnapshot;
  requestedBy: string;
  batchId?: string | null;
  /** True when the parent batch was fired by a script schedule. */
  scheduled?: boolean;
}): Promise<EnqueueRunResult> {
  const [inflight] = await db
    .select({ id: scriptRunJobs.id })
    .from(scriptRunJobs)
    .where(
      and(
        eq(scriptRunJobs.assetId, input.assetId),
        inArray(scriptRunJobs.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inflight) return { ok: false, reason: "already-inflight" };

  const [row] = await db
    .insert(scriptRunJobs)
    .values({
      assetId: input.assetId,
      targetIp: input.targetIp,
      scriptId: input.scriptId,
      batchId: input.batchId ?? null,
      scriptSnapshot: input.scriptSnapshot,
      requestedBy: input.requestedBy,
    })
    .returning({ id: scriptRunJobs.id });
  await upsertAuditEvent({
    sourceTable: SCRIPT_AUDIT_TABLE,
    sourceId: row.id,
    assetId: input.assetId,
    action: "script_run",
    operator: input.requestedBy.trim() || "system",
    source: input.scheduled ? "scheduled" : "admin_console",
    summary: scriptRunSummary(input.scriptSnapshot.name),
    details: {
      scriptId: input.scriptId,
      scriptName: input.scriptSnapshot.name,
      batchId: input.batchId ?? null,
    },
    status: "pending",
  });
  return { ok: true, id: row.id };
}

export type ClaimedScriptRun = {
  id: string;
  assetTag: string | null;
  targetIp: string;
  scriptSnapshot: ScriptSnapshot;
  workerId: string;
  claimedAt: string;
};

export async function claimNextScriptRun(
  workerId: string,
): Promise<ClaimedScriptRun | null> {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - SCRIPT_RUN_STUCK_TIMEOUT_MS,
  ).toISOString();

  await db
    .update(scriptRunJobs)
    .set({ status: "pending", workerId: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        inArray(scriptRunJobs.status, ["claimed", "running"]),
        sql`coalesce(${scriptRunJobs.startedAt}, ${scriptRunJobs.claimedAt}) < ${cutoffIso}`,
      ),
    );

  const claimedAtIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE ${scriptRunJobs}
    SET status = 'claimed',
        worker_id = ${workerId},
        claimed_at = ${claimedAtIso},
        updated_at = ${claimedAtIso}
    WHERE id = (
      SELECT id FROM ${scriptRunJobs}
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
      id: scriptRunJobs.id,
      assetTag: assets.tag,
      targetIp: scriptRunJobs.targetIp,
      scriptSnapshot: scriptRunJobs.scriptSnapshot,
      claimedAt: scriptRunJobs.claimedAt,
    })
    .from(scriptRunJobs)
    .leftJoin(assets, eq(assets.id, scriptRunJobs.assetId))
    .where(eq(scriptRunJobs.id, id))
    .limit(1);

  if (!job || !job.claimedAt || !job.scriptSnapshot) return null;
  return {
    id: job.id,
    assetTag: job.assetTag,
    targetIp: job.targetIp,
    scriptSnapshot: job.scriptSnapshot,
    workerId,
    claimedAt: job.claimedAt.toISOString(),
  };
}

export type StatusOutcome = "ok" | "notfound" | "stale";

export async function updateScriptRunStatus(
  jobId: string,
  u: {
    workerId: string;
    claimedAt: string;
    status: "running" | "succeeded" | "failed";
    result?: ScriptRunResult;
    error?: string;
  },
): Promise<StatusOutcome> {
  if (!UUID_RE.test(jobId)) return "notfound";
  const now = new Date();
  const claimedAt = new Date(u.claimedAt);

  const set: Partial<typeof scriptRunJobs.$inferInsert> = {
    status: u.status,
    updatedAt: now,
  };
  if (u.status === "running") set.startedAt = now;
  else {
    set.finishedAt = now;
    if (u.result) set.result = u.result;
    if (u.status === "failed" && u.error) set.error = u.error;
  }

  const updated = await db
    .update(scriptRunJobs)
    .set(set)
    .where(
      and(
        eq(scriptRunJobs.id, jobId),
        eq(scriptRunJobs.workerId, u.workerId),
        eq(scriptRunJobs.claimedAt, claimedAt),
        inArray(scriptRunJobs.status, ["claimed", "running"]),
      ),
    )
    .returning({
      id: scriptRunJobs.id,
      assetId: scriptRunJobs.assetId,
      snapshot: scriptRunJobs.scriptSnapshot,
      requestedBy: scriptRunJobs.requestedBy,
    });

  if (updated.length) {
    if (u.status === "succeeded" || u.status === "failed") {
      const row = updated[0];
      await updateAuditEventStatus({
        sourceTable: SCRIPT_AUDIT_TABLE,
        sourceId: row.id,
        status: u.status,
        ...(u.status === "succeeded" && u.result
          ? { summary: scriptRunSummary(row.snapshot.name, u.result.exitCode) }
          : {}),
      });
      await notifyScriptRunResult({
        jobId: row.id,
        status: u.status,
        assetId: row.assetId,
        scriptName: row.snapshot.name,
        error: u.error ?? null,
        requestedBy: row.requestedBy,
      });
    }
    return "ok";
  }

  const [exists] = await db
    .select({ id: scriptRunJobs.id })
    .from(scriptRunJobs)
    .where(eq(scriptRunJobs.id, jobId))
    .limit(1);
  return exists ? "stale" : "notfound";
}

export async function cancelScriptRun(jobId: string): Promise<boolean> {
  if (!UUID_RE.test(jobId)) return false;
  const now = new Date();
  const updated = await db
    .update(scriptRunJobs)
    .set({ status: "canceled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(scriptRunJobs.id, jobId),
        inArray(scriptRunJobs.status, [...IN_FLIGHT]),
      ),
    )
    .returning({ id: scriptRunJobs.id });
  if (updated.length) {
    await updateAuditEventStatus({
      sourceTable: SCRIPT_AUDIT_TABLE,
      sourceId: updated[0].id,
      status: "canceled",
    });
    return true;
  }
  return false;
}

export async function getScriptRun(
  jobId: string,
): Promise<ScriptRunJobRow | null> {
  if (!UUID_RE.test(jobId)) return null;
  const [row] = await db
    .select()
    .from(scriptRunJobs)
    .where(eq(scriptRunJobs.id, jobId))
    .limit(1);
  return row ?? null;
}

export type ScriptRunListItem = {
  id: string;
  scriptName: string;
  status: ScriptRunJobRow["status"];
  result: ScriptRunResult | null;
  requestedBy: string;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
  waitingForCollector: boolean;
};

export async function listScriptRunsForAssetTag(
  tag: string,
  limit = 20,
): Promise<ScriptRunListItem[]> {
  const rows = await db
    .select({
      id: scriptRunJobs.id,
      snapshot: scriptRunJobs.scriptSnapshot,
      status: scriptRunJobs.status,
      result: scriptRunJobs.result,
      requestedBy: scriptRunJobs.requestedBy,
      error: scriptRunJobs.error,
      requestedAt: scriptRunJobs.requestedAt,
      finishedAt: scriptRunJobs.finishedAt,
    })
    .from(scriptRunJobs)
    .innerJoin(assets, eq(assets.id, scriptRunJobs.assetId))
    .where(eq(assets.tag, tag))
    .orderBy(desc(scriptRunJobs.requestedAt))
    .limit(limit);

  const workerLive = await isWorkerLive();
  return rows.map((r) => ({
    id: r.id,
    scriptName: r.snapshot.name,
    status: r.status,
    result: r.result ?? null,
    requestedBy: r.requestedBy,
    error: r.error,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    waitingForCollector: r.status === "pending" && !workerLive,
  }));
}

export type ScriptRunFleetItem = ScriptRunListItem & {
  assetTag: string;
  assetName: string;
};

/** Recent runs across the fleet — for the /scripts library page. */
export async function listRecentScriptRuns(
  limit = 30,
): Promise<ScriptRunFleetItem[]> {
  const rows = await db
    .select({
      id: scriptRunJobs.id,
      snapshot: scriptRunJobs.scriptSnapshot,
      status: scriptRunJobs.status,
      result: scriptRunJobs.result,
      requestedBy: scriptRunJobs.requestedBy,
      error: scriptRunJobs.error,
      requestedAt: scriptRunJobs.requestedAt,
      finishedAt: scriptRunJobs.finishedAt,
      assetTag: assets.tag,
      assetName: assets.name,
    })
    .from(scriptRunJobs)
    .innerJoin(assets, eq(assets.id, scriptRunJobs.assetId))
    .orderBy(desc(scriptRunJobs.requestedAt))
    .limit(limit);

  const workerLive = await isWorkerLive();
  return rows.map((r) => ({
    id: r.id,
    scriptName: r.snapshot.name,
    status: r.status,
    result: r.result ?? null,
    requestedBy: r.requestedBy,
    error: r.error,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    waitingForCollector: r.status === "pending" && !workerLive,
    assetTag: r.assetTag,
    assetName: r.assetName,
  }));
}
