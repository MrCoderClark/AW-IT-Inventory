import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  formatAppUpgradeSummary,
  formatInstallSummary,
} from "@/lib/computer-audit-actions";

import { updateAuditEventStatus, upsertAuditEvent } from "./computer-audit";
import { db } from "./index";
import { enqueueMissingUpdateCheck } from "./missing-update-checks";
import { notifyPatchInstallResult } from "./notifications";
import { syncLinkedRebootsForInstall } from "./reboot";
import { enqueueScan, isWorkerLive } from "./scan";
import { resolveDeployTarget } from "./software-deploy";
import {
  appUpgrades,
  assets,
  patchInstallJobs,
  windowsMissingUpdates,
  windowsUpdateState,
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

export const FLEET_OS_INSTALL_TAG_CAP = 100;

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

export async function listMissingOsKbIds(assetId: string): Promise<string[]> {
  const rows = await db
    .select({ kbId: windowsMissingUpdates.kbId })
    .from(windowsMissingUpdates)
    .where(eq(windowsMissingUpdates.assetId, assetId));
  return rows.map((r) => r.kbId);
}

export type FleetOsSkipReason =
  | "no-ip"
  | "no-missing"
  | "already-inflight"
  | "not-found";

export async function enqueueFleetOsPatchInstalls(input: {
  tags: string[];
  requestedBy: string;
}): Promise<{
  enqueued: string[];
  skipped: { tag: string; reason: FleetOsSkipReason }[];
}> {
  const enqueued: string[] = [];
  const skipped: { tag: string; reason: FleetOsSkipReason }[] = [];
  const seen = new Set<string>();

  for (const raw of input.tags) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);

    const target = await resolveDeployTarget(tag);
    if (!target) {
      skipped.push({ tag, reason: "no-ip" });
      continue;
    }

    const kbIds = await listMissingOsKbIds(target.assetId);
    if (kbIds.length === 0) {
      skipped.push({ tag, reason: "no-missing" });
      continue;
    }

    const built = await buildPatchSelection(target.assetId, kbIds, []);
    if (!built.ok) {
      skipped.push({ tag, reason: "no-missing" });
      continue;
    }

    const enq = await enqueuePatchInstall({
      assetId: target.assetId,
      targetIp: target.ip,
      selection: built.selection,
      requestedBy: input.requestedBy,
    });
    if (!enq.ok) {
      skipped.push({ tag, reason: "already-inflight" });
      continue;
    }
    enqueued.push(enq.id);
  }

  return { enqueued, skipped };
}

/** One audit row per job. A lone app upgrade is `app_upgrade`; everything else is an OS patch install. */
function isSingleAppUpgrade(selection: PatchInstallSelection): boolean {
  return selection.apps.length === 1 && selection.os.length === 0;
}

function patchAuditAction(
  selection: PatchInstallSelection,
): "app_upgrade" | "os_patch_install" {
  return isSingleAppUpgrade(selection) ? "app_upgrade" : "os_patch_install";
}

function patchAuditSummary(selection: PatchInstallSelection): string {
  if (isSingleAppUpgrade(selection)) {
    const app = selection.apps[0];
    return formatAppUpgradeSummary(app.name, app.version, app.available);
  }
  const osCount = selection.os.length;
  const appCount = selection.apps.length;
  if (osCount > 0 && appCount === 0) {
    if (osCount === 1) return formatInstallSummary(selection.os[0].kbId, null);
    return `Installed ${osCount} Windows updates`;
  }
  if (appCount > 0 && osCount === 0) return `Updated ${appCount} apps`;
  if (osCount === 0 && appCount === 0) return "Installed updates";
  const osLabel = `${osCount} Windows update${osCount === 1 ? "" : "s"}`;
  const appLabel = `${appCount} app upgrade${appCount === 1 ? "" : "s"}`;
  return `Installed ${osLabel} and ${appLabel}`;
}

function patchAuditDetails(
  selection: PatchInstallSelection,
): Record<string, unknown> {
  return {
    osKbIds: selection.os.map((item) => item.kbId),
    appUpgrades: selection.apps.map((item) => ({
      id: item.packageId,
      from: item.version,
      to: item.available,
    })),
  };
}

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
  await upsertAuditEvent({
    sourceTable: "patch_install_jobs",
    sourceId: row.id,
    assetId: input.assetId,
    action: patchAuditAction(input.selection),
    operator: input.requestedBy,
    source: "admin_console",
    summary: patchAuditSummary(input.selection),
    details: patchAuditDetails(input.selection),
    status: "pending",
  });
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
      targetIp: patchInstallJobs.targetIp,
      selection: patchInstallJobs.selection,
      requestedBy: patchInstallJobs.requestedBy,
    });

  if (updated.length) {
    if (u.status === "succeeded" || u.status === "failed") {
      const row = updated[0];
      await updateAuditEventStatus({
        sourceTable: "patch_install_jobs",
        sourceId: row.id,
        status: u.status,
        summary: patchAuditSummary(row.selection),
        details: patchAuditDetails(row.selection),
      });
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
    if (u.status === "succeeded" || u.status === "failed") {
      await syncLinkedRebootsForInstall(jobId, u.status);
    }
    if (u.status === "succeeded") {
      // Drop installed OS ids from Missing immediately. When reboot is required,
      // WUA Search still lists them until reboot — so skip auto Check updates
      // (it would put the rows right back).
      try {
        await applySuccessfulOsInstallInventory(
          updated[0].assetId,
          u.result,
        );
      } catch (err) {
        console.error("post-patch-install missing-list update failed", err);
      }
      await enqueuePostInstallFollowUp(updated[0], {
        skipMissingCheck: u.result?.rebootRequired === true,
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

/**
 * Remove successfully installed OS KBs/GUIDs from the Missing list and refresh
 * missingCount. Sets pendingReboot when the install result requires it.
 */
export async function applySuccessfulOsInstallInventory(
  assetId: string,
  result: PatchInstallResult | undefined,
): Promise<void> {
  const okOsIds = (result?.items ?? [])
    .filter((i) => i.kind === "os" && i.ok && i.id)
    .map((i) => i.id);
  const rebootRequired = result?.rebootRequired === true;
  if (!okOsIds.length && !rebootRequired) return;

  if (okOsIds.length) {
    await db
      .delete(windowsMissingUpdates)
      .where(
        and(
          eq(windowsMissingUpdates.assetId, assetId),
          inArray(windowsMissingUpdates.kbId, okOsIds),
        ),
      );
  }

  const remaining = await db
    .select({ kbId: windowsMissingUpdates.kbId })
    .from(windowsMissingUpdates)
    .where(eq(windowsMissingUpdates.assetId, assetId));

  const patch: {
    missingCount: number;
    pendingReboot?: boolean;
  } = { missingCount: remaining.length };
  if (rebootRequired) patch.pendingReboot = true;

  await db
    .update(windowsUpdateState)
    .set(patch)
    .where(eq(windowsUpdateState.assetId, assetId));
}

/** Best-effort follow-up after a successful install (scan and/or Check updates). */
export async function enqueuePostInstallFollowUp(
  job: {
    assetId: string;
    targetIp: string;
    requestedBy: string;
    selection: PatchInstallSelection;
  },
  opts: { skipMissingCheck?: boolean } = {},
): Promise<void> {
  const ip = (job.targetIp ?? "").trim();
  if (!ip) return;
  const by = `patch-install:${job.requestedBy || "system"}`;
  const hasApps = (job.selection?.apps?.length ?? 0) > 0;
  const hasOs = (job.selection?.os?.length ?? 0) > 0;

  if (hasApps) {
    try {
      await enqueueScan({
        scope: "selected",
        targets: [ip],
        requestedBy: by,
      });
    } catch (err) {
      console.error("post-patch-install scan enqueue failed", err);
    }
  }

  if (hasOs && !opts.skipMissingCheck) {
    try {
      await enqueueMissingUpdateCheck({
        assetId: job.assetId,
        targetIp: ip,
        requestedBy: by,
      });
    } catch (err) {
      console.error("post-patch-install missing-update check enqueue failed", err);
    }
  }
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
  if (updated.length) {
    await updateAuditEventStatus({
      sourceTable: "patch_install_jobs",
      sourceId: updated[0].id,
      status: "canceled",
    });
    await syncLinkedRebootsForInstall(jobId, "canceled");
    return true;
  }
  return false;
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
