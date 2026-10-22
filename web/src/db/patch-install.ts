import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "./index";
import { notifyPatchInstallResult } from "./notifications";
import { isWorkerLive } from "./scan";
import { resolveDeployTarget } from "./software-deploy";
import {
  appUpgrades,
  assets,
  patchInstallJobs,
  windowsMissingUpdates,
  type PatchInstallJobRow,
  type PatchInstallResult,
  type PatchInstallSelection,
} from "./schema";

/**
 * Patch-install queue (spec 31 phase 3). Same outbound-only claim / fenced
 * status / reaper shape as software deploy. Selection is frozen at enqueue;
 * credentials never land on the row.
 */

export const PATCH_INSTALL_STUCK_TIMEOUT_MS = Number(
  process.env.PATCH_INSTALL_STUCK_JOB_TIMEOUT_MS ?? 20 * 60 * 1000,
);

/** Max simultaneous patch installs (claimed|running) fleet-wide; env `PATCH_INSTALL_MAX_CONCURRENT`. */
export function getPatchInstallMaxConcurrent(): number {
  return Math.max(1, Number(process.env.PATCH_INSTALL_MAX_CONCURRENT ?? 5));
}

export { getPatchInstallMaxConcurrent as patchInstallMaxConcurrent };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IN_FLIGHT = ["pending", "claimed", "running"] as const;

export { resolveDeployTarget };

export type BuildSelectionResult =
  | { ok: true; selection: PatchInstallSelection }
  | { ok: false; reason: "empty" | "unknown-ids" };

/**
 * Resolve selected kb / package ids against current inventory for the asset.
 * Unknown ids → reject (admin must refresh and re-pick).
 */
export async function buildPatchSelection(
  assetId: string,
  osKbIds: string[],
  packageIds: string[],
): Promise<BuildSelectionResult> {
  const osWanted = [
    ...new Set(osKbIds.map((s) => s.trim()).filter(Boolean)),
  ];
  const appWanted = [
    ...new Set(packageIds.map((s) => s.trim()).filter(Boolean)),
  ];
  if (osWanted.length === 0 && appWanted.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const [missingRows, upgradeRows] = await Promise.all([
    osWanted.length
      ? db
          .select({
            kbId: windowsMissingUpdates.kbId,
            title: windowsMissingUpdates.title,
          })
          .from(windowsMissingUpdates)
          .where(
            and(
              eq(windowsMissingUpdates.assetId, assetId),
              inArray(windowsMissingUpdates.kbId, osWanted),
            ),
          )
      : Promise.resolve([] as { kbId: string; title: string }[]),
    appWanted.length
      ? db
          .select({
            packageId: appUpgrades.packageId,
            name: appUpgrades.name,
            version: appUpgrades.version,
            available: appUpgrades.available,
          })
          .from(appUpgrades)
          .where(
            and(
              eq(appUpgrades.assetId, assetId),
              inArray(appUpgrades.packageId, appWanted),
            ),
          )
      : Promise.resolve(
          [] as {
            packageId: string;
            name: string;
            version: string | null;
            available: string | null;
          }[],
        ),
  ]);

  if (missingRows.length !== osWanted.length || upgradeRows.length !== appWanted.length) {
    return { ok: false, reason: "unknown-ids" };
  }

  const missingById = new Map(missingRows.map((r) => [r.kbId, r]));
  const upgradeById = new Map(upgradeRows.map((r) => [r.packageId, r]));

  return {
    ok: true,
    selection: {
      os: osWanted.map((id) => {
        const r = missingById.get(id)!;
        return { kbId: r.kbId, title: r.title };
      }),
      apps: appWanted.map((id) => {
        const r = upgradeById.get(id)!;
        return {
          packageId: r.packageId,
          name: r.name,
          version: r.version,
          available: r.available,
        };
      }),
    },
  };
}

export type EnqueuePatchResult =
  | { ok: true; id: string }
  | { ok: false; reason: "already-inflight" };

export async function enqueuePatchInstall(input: {
  assetId: string;
  targetIp: string;
  selection: PatchInstallSelection;
  requestedBy: string;
}): Promise<EnqueuePatchResult> {
  const [inflight] = await db
    .select({ id: patchInstallJobs.id })
    .from(patchInstallJobs)
    .where(
      and(
        eq(patchInstallJobs.assetId, input.assetId),
        inArray(patchInstallJobs.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inflight) return { ok: false, reason: "already-inflight" };

  const [row] = await db
    .insert(patchInstallJobs)
    .values({
      assetId: input.assetId,
      targetIp: input.targetIp,
      selection: input.selection,
      requestedBy: input.requestedBy,
    })
    .returning({ id: patchInstallJobs.id });
  return { ok: true, id: row.id };
}

export type ClaimedPatchInstall = {
  id: string;
  assetTag: string | null;
  targetIp: string;
  selection: PatchInstallSelection;
  workerId: string;
  claimedAt: string;
};

export async function claimNextPatchInstall(
  workerId: string,
): Promise<ClaimedPatchInstall | null> {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - PATCH_INSTALL_STUCK_TIMEOUT_MS,
  ).toISOString();

  await db
    .update(patchInstallJobs)
    .set({ status: "pending", workerId: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        inArray(patchInstallJobs.status, ["claimed", "running"]),
        sql`coalesce(${patchInstallJobs.startedAt}, ${patchInstallJobs.claimedAt}) < ${cutoffIso}`,
      ),
    );

  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(patchInstallJobs)
    .where(inArray(patchInstallJobs.status, ["claimed", "running"]));
  if ((countRow?.n ?? 0) >= getPatchInstallMaxConcurrent()) {
    return null;
  }

  const claimedAtIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE ${patchInstallJobs}
    SET status = 'claimed',
        worker_id = ${workerId},
        claimed_at = ${claimedAtIso},
        updated_at = ${claimedAtIso}
    WHERE id = (
      SELECT id FROM ${patchInstallJobs}
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
      id: patchInstallJobs.id,
      assetTag: assets.tag,
      targetIp: patchInstallJobs.targetIp,
      selection: patchInstallJobs.selection,
      claimedAt: patchInstallJobs.claimedAt,
    })
    .from(patchInstallJobs)
    .leftJoin(assets, eq(assets.id, patchInstallJobs.assetId))
    .where(eq(patchInstallJobs.id, id))
    .limit(1);

  if (!job || !job.claimedAt || !job.selection) return null;
  return {
    id: job.id,
    assetTag: job.assetTag,
    targetIp: job.targetIp,
    selection: job.selection,
    workerId,
    claimedAt: job.claimedAt.toISOString(),
  };
}

export type StatusOutcome = "ok" | "notfound" | "stale";

export type PatchInstallStatusUpdate = {
  workerId: string;
  claimedAt: string;
  status: "running" | "succeeded" | "failed";
  result?: PatchInstallResult;
  error?: string;
};

export async function updatePatchInstallStatus(
  jobId: string,
  u: PatchInstallStatusUpdate,
): Promise<StatusOutcome> {
  if (!UUID_RE.test(jobId)) return "notfound";
  const now = new Date();
  const claimedAt = new Date(u.claimedAt);

  const set: Partial<typeof patchInstallJobs.$inferInsert> = {
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
    .update(patchInstallJobs)
    .set(set)
    .where(
      and(
        eq(patchInstallJobs.id, jobId),
        eq(patchInstallJobs.workerId, u.workerId),
        eq(patchInstallJobs.claimedAt, claimedAt),
        inArray(patchInstallJobs.status, ["claimed", "running"]),
      ),
    )
    .returning({
      id: patchInstallJobs.id,
      assetId: patchInstallJobs.assetId,
      selection: patchInstallJobs.selection,
      requestedBy: patchInstallJobs.requestedBy,
    });

  if (updated.length) {
    if (u.status === "succeeded" || u.status === "failed") {
      const row = updated[0];
      await notifyPatchInstallResult({
        jobId: row.id,
        status: u.status,
        assetId: row.assetId,
        osCount: row.selection.os.length,
        appCount: row.selection.apps.length,
        error: u.error ?? null,
        requestedBy: row.requestedBy,
      });
    }
    return "ok";
  }

  const [exists] = await db
    .select({ id: patchInstallJobs.id })
    .from(patchInstallJobs)
    .where(eq(patchInstallJobs.id, jobId))
    .limit(1);
  return exists ? "stale" : "notfound";
}

export async function cancelPatchInstall(jobId: string): Promise<boolean> {
  if (!UUID_RE.test(jobId)) return false;
  const now = new Date();
  const updated = await db
    .update(patchInstallJobs)
    .set({ status: "canceled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(patchInstallJobs.id, jobId),
        inArray(patchInstallJobs.status, [...IN_FLIGHT]),
      ),
    )
    .returning({ id: patchInstallJobs.id });
  return updated.length > 0;
}

export async function getPatchInstallJob(
  jobId: string,
): Promise<PatchInstallJobRow | null> {
  if (!UUID_RE.test(jobId)) return null;
  const [row] = await db
    .select()
    .from(patchInstallJobs)
    .where(eq(patchInstallJobs.id, jobId))
    .limit(1);
  return row ?? null;
}

export async function prunePatchInstallJobs(cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(patchInstallJobs)
    .where(
      and(
        inArray(patchInstallJobs.status, ["succeeded", "failed", "canceled"]),
        sql`${patchInstallJobs.finishedAt} < ${cutoff.toISOString()}`,
      ),
    )
    .returning({ id: patchInstallJobs.id });
  return deleted.length;
}

export type PatchInstallListItem = {
  id: string;
  osCount: number;
  appCount: number;
  status: PatchInstallJobRow["status"];
  result: PatchInstallResult | null;
  requestedBy: string;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
  waitingForCollector: boolean;
};

export async function listPatchInstallsForAssetTag(
  tag: string,
  limit = 20,
): Promise<PatchInstallListItem[]> {
  const rows = await db
    .select({
      id: patchInstallJobs.id,
      selection: patchInstallJobs.selection,
      status: patchInstallJobs.status,
      result: patchInstallJobs.result,
      requestedBy: patchInstallJobs.requestedBy,
      error: patchInstallJobs.error,
      requestedAt: patchInstallJobs.requestedAt,
      finishedAt: patchInstallJobs.finishedAt,
    })
    .from(patchInstallJobs)
    .innerJoin(assets, eq(assets.id, patchInstallJobs.assetId))
    .where(eq(assets.tag, tag))
    .orderBy(desc(patchInstallJobs.requestedAt))
    .limit(limit);

  const workerLive = await isWorkerLive();

  return rows.map((r) => ({
    id: r.id,
    osCount: r.selection.os.length,
    appCount: r.selection.apps.length,
    status: r.status,
    result: r.result ?? null,
    requestedBy: r.requestedBy,
    error: r.error,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    waitingForCollector: r.status === "pending" && !workerLive,
  }));
}
