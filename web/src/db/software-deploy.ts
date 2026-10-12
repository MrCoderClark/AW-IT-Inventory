import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "./index";
import { notifyDeployResult } from "./notifications";
import { isWorkerLive } from "./scan";
import {
  assets,
  computerDetails,
  softwareDeployments,
  type SoftwareDeployResult,
  type SoftwareDeploymentRow,
  type SoftwarePackageSnapshot,
} from "./schema";

/**
 * The software-deployment queue (spec 23). Same outbound-only, atomic-claim /
 * fenced-status / reaper machinery as the scan and printer-install queues
 * (`db/scan.ts`, `db/printer-install.ts`): the web owns the queue, the collector
 * worker pulls a job + the installer bytes and pushes the result. Everything here
 * is server-only, and every row/payload is credential-free (AC-9).
 */

export const DEPLOY_STUCK_TIMEOUT_MS = Number(
  process.env.DEPLOY_STUCK_JOB_TIMEOUT_MS ?? 15 * 60 * 1000,
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IN_FLIGHT = ["pending", "claimed", "running"] as const;

/* ---------------- Enqueue / target (cookie side) ---------------- */

/**
 * Resolve a deploy target from a computer's human tag: the asset uuid and its
 * entered IP (`computer_details.ip_address`). Null when the asset isn't a Computer,
 * doesn't exist, or has no IP — the caller then refuses (422, AC-2).
 */
export async function resolveDeployTarget(
  tag: string,
): Promise<{ assetId: string; ip: string } | null> {
  const [row] = await db
    .select({
      assetId: assets.id,
      type: assets.type,
      ip: computerDetails.ipAddress,
    })
    .from(assets)
    .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
    .where(eq(assets.tag, tag))
    .limit(1);
  if (!row || row.type !== "Computer" || !row.ip) return null;
  return { assetId: row.assetId, ip: row.ip };
}

export type EnqueueDeployResult =
  | { ok: true; id: string }
  | { ok: false; reason: "already-inflight" };

/**
 * Enqueue a deployment with a frozen package snapshot. Soft one-in-flight-per-
 * target guard (AC-10): refuses when the computer already has a pending/claimed/
 * running deployment.
 */
export async function enqueueDeployment(input: {
  assetId: string;
  targetIp: string;
  packageId: string;
  packageSnapshot: SoftwarePackageSnapshot;
  requestedBy: string;
}): Promise<EnqueueDeployResult> {
  const [inflight] = await db
    .select({ id: softwareDeployments.id })
    .from(softwareDeployments)
    .where(
      and(
        eq(softwareDeployments.assetId, input.assetId),
        inArray(softwareDeployments.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inflight) return { ok: false, reason: "already-inflight" };

  const [row] = await db
    .insert(softwareDeployments)
    .values({
      assetId: input.assetId,
      targetIp: input.targetIp,
      packageId: input.packageId,
      packageSnapshot: input.packageSnapshot,
      requestedBy: input.requestedBy,
    })
    .returning({ id: softwareDeployments.id });
  return { ok: true, id: row.id };
}

/* ---------------- Claim / status (worker side) ---------------- */

export type ClaimedDeployment = {
  id: string;
  assetTag: string | null;
  targetIp: string;
  packageSnapshot: SoftwarePackageSnapshot;
  workerId: string;
  claimedAt: string; // ISO; echoed back as the claim fence
};

/**
 * Reap stale claims then atomically claim the oldest pending deployment (mirrors
 * `claimNextInstallJob`). A single UPDATE gated by FOR UPDATE SKIP LOCKED so two
 * workers never take the same job. A claim/run idle past the timeout is requeued.
 */
export async function claimNextDeployment(
  workerId: string,
): Promise<ClaimedDeployment | null> {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - DEPLOY_STUCK_TIMEOUT_MS,
  ).toISOString();

  await db
    .update(softwareDeployments)
    .set({ status: "pending", workerId: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        inArray(softwareDeployments.status, ["claimed", "running"]),
        sql`coalesce(${softwareDeployments.startedAt}, ${softwareDeployments.claimedAt}) < ${cutoffIso}`,
      ),
    );

  const claimedAtIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE ${softwareDeployments}
    SET status = 'claimed',
        worker_id = ${workerId},
        claimed_at = ${claimedAtIso},
        updated_at = ${claimedAtIso}
    WHERE id = (
      SELECT id FROM ${softwareDeployments}
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
      id: softwareDeployments.id,
      assetTag: assets.tag,
      targetIp: softwareDeployments.targetIp,
      packageSnapshot: softwareDeployments.packageSnapshot,
      claimedAt: softwareDeployments.claimedAt,
    })
    .from(softwareDeployments)
    .leftJoin(assets, eq(assets.id, softwareDeployments.assetId))
    .where(eq(softwareDeployments.id, id))
    .limit(1);

  if (!job || !job.claimedAt || !job.packageSnapshot) return null;
  return {
    id: job.id,
    assetTag: job.assetTag,
    targetIp: job.targetIp,
    packageSnapshot: job.packageSnapshot,
    workerId,
    claimedAt: job.claimedAt.toISOString(),
  };
}

export type StatusOutcome = "ok" | "notfound" | "stale";

export type DeployStatusUpdate = {
  workerId: string;
  claimedAt: string;
  status: "running" | "succeeded" | "failed";
  result?: SoftwareDeployResult;
  error?: string;
};

/** Apply a worker's status update, fenced by the claim (409 → stale). */
export async function updateDeploymentStatus(
  deploymentId: string,
  u: DeployStatusUpdate,
): Promise<StatusOutcome> {
  if (!UUID_RE.test(deploymentId)) return "notfound";
  const now = new Date();
  const claimedAt = new Date(u.claimedAt);

  const set: Partial<typeof softwareDeployments.$inferInsert> = {
    status: u.status,
    updatedAt: now,
  };
  if (u.status === "running") {
    set.startedAt = now;
  } else {
    set.finishedAt = now;
    if (u.status === "succeeded" && u.result) set.result = u.result;
    if (u.status === "failed") {
      if (u.result) set.result = u.result;
      if (u.error) set.error = u.error;
    }
  }

  const updated = await db
    .update(softwareDeployments)
    .set(set)
    .where(
      and(
        eq(softwareDeployments.id, deploymentId),
        eq(softwareDeployments.workerId, u.workerId),
        eq(softwareDeployments.claimedAt, claimedAt),
        inArray(softwareDeployments.status, ["claimed", "running"]),
      ),
    )
    .returning({
      id: softwareDeployments.id,
      assetId: softwareDeployments.assetId,
      snapshot: softwareDeployments.packageSnapshot,
    });

  if (updated.length) {
    // A finished deployment raises an in-app notification (spec 23, AC-6), like the
    // printer-install one. Best-effort + idempotent per deployment+status.
    if (u.status === "succeeded" || u.status === "failed") {
      const row = updated[0];
      await notifyDeployResult({
        deploymentId: row.id,
        status: u.status,
        assetId: row.assetId,
        packageName: row.snapshot.name,
        packageVersion: row.snapshot.version,
        error: u.error ?? null,
      });
    }
    return "ok";
  }

  const [exists] = await db
    .select({ id: softwareDeployments.id })
    .from(softwareDeployments)
    .where(eq(softwareDeployments.id, deploymentId))
    .limit(1);
  return exists ? "stale" : "notfound";
}

/**
 * Cancel a still-active deployment (`pending`/`claimed`/`running`). Fenced like
 * printer install: once this flips the row to `canceled`, the worker's late result
 * post no-ops (409 stale). Returns false when already terminal or unknown. Does
 * NOT stop an install already underway on the target.
 */
export async function cancelDeployment(deploymentId: string): Promise<boolean> {
  if (!UUID_RE.test(deploymentId)) return false;
  const now = new Date();
  const updated = await db
    .update(softwareDeployments)
    .set({ status: "canceled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(softwareDeployments.id, deploymentId),
        inArray(softwareDeployments.status, [...IN_FLIGHT]),
      ),
    )
    .returning({ id: softwareDeployments.id });
  return updated.length > 0;
}

/** One deployment row by id, or null (for ownership/status checks in actions). */
export async function getDeployment(
  deploymentId: string,
): Promise<SoftwareDeploymentRow | null> {
  if (!UUID_RE.test(deploymentId)) return null;
  const [row] = await db
    .select()
    .from(softwareDeployments)
    .where(eq(softwareDeployments.id, deploymentId))
    .limit(1);
  return row ?? null;
}

/** Delete terminal deployments (succeeded/failed/canceled) finished before the
    cutoff — daily retention prune. In-flight rows are never touched. */
export async function pruneDeployments(cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(softwareDeployments)
    .where(
      and(
        inArray(softwareDeployments.status, ["succeeded", "failed", "canceled"]),
        sql`${softwareDeployments.finishedAt} < ${cutoff.toISOString()}`,
      ),
    )
    .returning({ id: softwareDeployments.id });
  return deleted.length;
}

/* ---------------- History (read) ---------------- */

export type DeploymentListItem = {
  id: string;
  packageName: string;
  packageVersion: string;
  stepCount: number;
  status: SoftwareDeploymentRow["status"];
  result: SoftwareDeployResult | null;
  requestedBy: string;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
  waitingForCollector: boolean;
};

/** Deployment history for one computer, newest first (for the detail panel). */
export async function listDeploymentsForAssetTag(
  tag: string,
  limit = 20,
): Promise<DeploymentListItem[]> {
  const rows = await db
    .select({
      id: softwareDeployments.id,
      snapshot: softwareDeployments.packageSnapshot,
      status: softwareDeployments.status,
      result: softwareDeployments.result,
      requestedBy: softwareDeployments.requestedBy,
      error: softwareDeployments.error,
      requestedAt: softwareDeployments.requestedAt,
      finishedAt: softwareDeployments.finishedAt,
    })
    .from(softwareDeployments)
    .innerJoin(assets, eq(assets.id, softwareDeployments.assetId))
    .where(eq(assets.tag, tag))
    .orderBy(desc(softwareDeployments.requestedAt))
    .limit(limit);

  const workerLive = await isWorkerLive();

  return rows.map((r) => ({
    id: r.id,
    packageName: r.snapshot.name,
    packageVersion: r.snapshot.version,
    stepCount: r.snapshot.steps.length,
    status: r.status,
    result: r.result ?? null,
    requestedBy: r.requestedBy,
    error: r.error,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    waitingForCollector: r.status === "pending" && !workerLive,
  }));
}
