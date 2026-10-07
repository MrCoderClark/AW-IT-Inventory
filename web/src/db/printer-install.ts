import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "./index";
import { isWorkerLive } from "./scan";
import {
  assets,
  computerDetails,
  printerDetails,
  printerInstallJobs,
  type InstalledPrinter,
  type PrinterInstallConnection,
  type PrinterInstallJobRow,
  type PrinterInstallResult,
  type PrinterPackageSnapshot,
} from "./schema";

/**
 * The remote printer-install queue (spec 20). Same outbound-only, atomic-claim /
 * fenced-status / reaper machinery as the scan queue (`db/scan.ts`): the web owns
 * the queue, the collector worker pulls a job + the driver bundle and pushes the
 * result. Everything here is server-only. The worker heartbeat (`isWorkerLive`,
 * shared with scans) drives the "waiting for collector" state.
 */

export const INSTALL_STUCK_TIMEOUT_MS = Number(
  process.env.INSTALL_STUCK_JOB_TIMEOUT_MS ?? 10 * 60 * 1000,
);

export type ClaimedInstallJob = {
  id: string;
  action: "install" | "list" | "remove";
  assetTag: string | null;
  targetIp: string;
  packageId: string | null;
  packageSnapshot: PrinterPackageSnapshot | null;
  printerName: string | null;
  connection: PrinterInstallConnection | null;
  workerId: string;
  claimedAt: string; // ISO; echoed back as the claim fence
};

/**
 * Reap stale claims then atomically claim the oldest pending install job
 * (mirrors `claimNextJob`). Single UPDATE gated by FOR UPDATE SKIP LOCKED so two
 * workers never take the same job. The heartbeat is recorded by the scan claim
 * (one worker process), so this does not re-upsert it.
 */
export async function claimNextInstallJob(
  workerId: string,
): Promise<ClaimedInstallJob | null> {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - INSTALL_STUCK_TIMEOUT_MS,
  ).toISOString();
  await db
    .update(printerInstallJobs)
    .set({ status: "pending", workerId: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        inArray(printerInstallJobs.status, ["claimed", "running"]),
        sql`coalesce(${printerInstallJobs.startedAt}, ${printerInstallJobs.claimedAt}) < ${cutoffIso}`,
      ),
    );

  const claimedAtIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE ${printerInstallJobs}
    SET status = 'claimed',
        worker_id = ${workerId},
        claimed_at = ${claimedAtIso},
        updated_at = ${claimedAtIso}
    WHERE id = (
      SELECT id FROM ${printerInstallJobs}
      WHERE status = 'pending'
      ORDER BY requested_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  const id = rows[0]?.id;
  if (!id) return null;

  // Re-read with the asset tag joined (for worker logging) under the fresh claim.
  const [job] = await db
    .select({
      id: printerInstallJobs.id,
      action: printerInstallJobs.action,
      assetTag: assets.tag,
      targetIp: printerInstallJobs.targetIp,
      packageId: printerInstallJobs.packageId,
      packageSnapshot: printerInstallJobs.packageSnapshot,
      printerName: printerInstallJobs.printerName,
      connection: printerInstallJobs.connection,
      claimedAt: printerInstallJobs.claimedAt,
    })
    .from(printerInstallJobs)
    .leftJoin(assets, eq(assets.id, printerInstallJobs.assetId))
    .where(eq(printerInstallJobs.id, id))
    .limit(1);

  if (!job || !job.claimedAt) return null;
  return {
    id: job.id,
    action: job.action,
    assetTag: job.assetTag,
    targetIp: job.targetIp,
    packageId: job.packageId,
    packageSnapshot: job.packageSnapshot,
    printerName: job.printerName,
    connection: job.connection,
    workerId,
    claimedAt: job.claimedAt.toISOString(),
  };
}

export type InstallStatusUpdate = {
  workerId: string;
  claimedAt: string;
  status: "running" | "succeeded" | "failed";
  result?: PrinterInstallResult;
  error?: string;
};

export type StatusOutcome = "ok" | "notfound" | "stale";

/** Apply a worker's status update, fenced by the claim (409 → stale). */
export async function updateInstallJobStatus(
  jobId: string,
  u: InstallStatusUpdate,
): Promise<StatusOutcome> {
  const now = new Date();
  const claimedAt = new Date(u.claimedAt);

  const set: Partial<typeof printerInstallJobs.$inferInsert> = {
    status: u.status,
    updatedAt: now,
  };
  if (u.status === "running") {
    set.startedAt = now;
  } else {
    set.finishedAt = now;
    if (u.status === "succeeded" && u.result) set.result = u.result;
    if (u.status === "failed" && u.error) set.error = u.error;
  }

  const updated = await db
    .update(printerInstallJobs)
    .set(set)
    .where(
      and(
        eq(printerInstallJobs.id, jobId),
        eq(printerInstallJobs.workerId, u.workerId),
        eq(printerInstallJobs.claimedAt, claimedAt),
        inArray(printerInstallJobs.status, ["claimed", "running"]),
      ),
    )
    .returning({ id: printerInstallJobs.id });

  if (updated.length) return "ok";

  const exists = await db
    .select({ id: printerInstallJobs.id })
    .from(printerInstallJobs)
    .where(eq(printerInstallJobs.id, jobId))
    .limit(1);
  return exists.length ? "stale" : "notfound";
}

/** Enqueue an install job with a frozen package snapshot + connection. */
export async function enqueueInstall(input: {
  assetId: string;
  targetIp: string;
  packageId: string;
  packageSnapshot: PrinterPackageSnapshot;
  printerName: string;
  connection: PrinterInstallConnection;
  sourcePrinterAssetId?: string | null;
  requestedBy: string;
}): Promise<string> {
  const [row] = await db
    .insert(printerInstallJobs)
    .values({
      assetId: input.assetId,
      targetIp: input.targetIp,
      packageId: input.packageId,
      packageSnapshot: input.packageSnapshot,
      printerName: input.printerName,
      connection: input.connection,
      sourcePrinterAssetId: input.sourcePrinterAssetId ?? null,
      requestedBy: input.requestedBy,
    })
    .returning({ id: printerInstallJobs.id });
  return row.id;
}

/** Enqueue a "list the computer's printers" op (no package/connection). */
export async function enqueueList(input: {
  assetId: string;
  targetIp: string;
  requestedBy: string;
}): Promise<string> {
  const [row] = await db
    .insert(printerInstallJobs)
    .values({
      assetId: input.assetId,
      targetIp: input.targetIp,
      action: "list",
      requestedBy: input.requestedBy,
    })
    .returning({ id: printerInstallJobs.id });
  return row.id;
}

/** Enqueue a "remove this printer by name" op. */
export async function enqueueRemove(input: {
  assetId: string;
  targetIp: string;
  printerName: string;
  requestedBy: string;
}): Promise<string> {
  const [row] = await db
    .insert(printerInstallJobs)
    .values({
      assetId: input.assetId,
      targetIp: input.targetIp,
      action: "remove",
      printerName: input.printerName,
      requestedBy: input.requestedBy,
    })
    .returning({ id: printerInstallJobs.id });
  return row.id;
}

export type PrinterListSnapshot = {
  printers: InstalledPrinter[];
  scannedAt: string;
};

/** The printers found by the most recent successful `list` op for a computer. */
export async function getLatestPrinterList(
  tag: string,
): Promise<PrinterListSnapshot | null> {
  const [row] = await db
    .select({
      result: printerInstallJobs.result,
      finishedAt: printerInstallJobs.finishedAt,
    })
    .from(printerInstallJobs)
    .innerJoin(assets, eq(assets.id, printerInstallJobs.assetId))
    .where(
      and(
        eq(assets.tag, tag),
        eq(printerInstallJobs.action, "list"),
        eq(printerInstallJobs.status, "succeeded"),
      ),
    )
    .orderBy(desc(printerInstallJobs.finishedAt))
    .limit(1);
  if (!row?.result?.printers) return null;
  return {
    printers: row.result.printers,
    scannedAt: row.finishedAt ? row.finishedAt.toISOString() : "",
  };
}

/** Cancel a still-pending install job. False if it isn't pending. */
export async function cancelPendingInstall(jobId: string): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(printerInstallJobs)
    .set({ status: "canceled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(printerInstallJobs.id, jobId),
        eq(printerInstallJobs.status, "pending"),
      ),
    )
    .returning({ id: printerInstallJobs.id });
  return updated.length > 0;
}

export type InstallJobListItem = {
  id: string;
  action: PrinterInstallJobRow["action"];
  packageId: string | null;
  printerName: string | null;
  status: PrinterInstallJobRow["status"];
  connection: PrinterInstallConnection | null;
  result: PrinterInstallResult | null;
  requestedBy: string;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
  waitingForCollector: boolean;
};

/**
 * Install history for one computer, newest first (for the detail panel). Keyed
 * by the human tag the UI holds (joined to the asset uuid FK).
 */
export async function listInstallJobsForAssetTag(
  tag: string,
  limit = 20,
): Promise<InstallJobListItem[]> {
  const rows = await db
    .select({
      id: printerInstallJobs.id,
      action: printerInstallJobs.action,
      packageId: printerInstallJobs.packageId,
      printerName: printerInstallJobs.printerName,
      status: printerInstallJobs.status,
      connection: printerInstallJobs.connection,
      result: printerInstallJobs.result,
      requestedBy: printerInstallJobs.requestedBy,
      error: printerInstallJobs.error,
      requestedAt: printerInstallJobs.requestedAt,
      finishedAt: printerInstallJobs.finishedAt,
    })
    .from(printerInstallJobs)
    .innerJoin(assets, eq(assets.id, printerInstallJobs.assetId))
    .where(eq(assets.tag, tag))
    .orderBy(desc(printerInstallJobs.requestedAt))
    .limit(limit);

  const workerLive = await isWorkerLive();

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    packageId: r.packageId,
    printerName: r.printerName,
    status: r.status,
    connection: r.connection,
    result: r.result ?? null,
    requestedBy: r.requestedBy,
    error: r.error,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    waitingForCollector: r.status === "pending" && !workerLive,
  }));
}

/**
 * Resolve an install target from a computer's human tag: the asset uuid and its
 * entered IP (`computer_details.ip_address`). Returns null when the asset isn't a
 * Computer, doesn't exist, or has no IP — the caller then refuses (422, AC-2).
 */
export async function resolveInstallTarget(
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

export type PrinterPrefillOption = {
  assetId: string;
  tag: string;
  name: string;
  ip: string;
  model: string | null;
};

/** Printer assets with an IP, to prefill the install form (name/host). */
export async function getPrinterPrefillOptions(): Promise<PrinterPrefillOption[]> {
  const rows = await db
    .select({
      assetId: assets.id,
      tag: assets.tag,
      name: assets.name,
      model: assets.model,
      ip: printerDetails.ipAddress,
    })
    .from(assets)
    .innerJoin(printerDetails, eq(printerDetails.assetId, assets.id))
    .where(eq(assets.type, "Printer"))
    .orderBy(assets.name);
  return rows.map((r) => ({
    assetId: r.assetId,
    tag: r.tag,
    name: r.name,
    ip: r.ip,
    model: r.model,
  }));
}
