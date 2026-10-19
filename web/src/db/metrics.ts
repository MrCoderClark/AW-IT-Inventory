import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "./index";
import { assets, deviceMetrics } from "./schema";

/* Device metric telemetry (spec 29). Lightweight time-series the worker samples on
   a cadence (CPU/RAM/disk/uptime), stored one row per (asset, sample) and retention-
   pruned. `recordMetrics` ingests a batch; `getDeviceMetrics` serves the per-device
   sparklines; `pruneMetrics` keeps the table bounded. Server-only. */

export interface MetricSample {
  assetId: string;
  sampledAt: Date;
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
  uptimeSec: number | null;
}

/** Insert a batch of samples (one row each). Rows without an asset id or timestamp
   are dropped; an unreadable gauge stays null (a gap, never 0). Returns the count
   inserted. */
export async function recordMetrics(samples: MetricSample[]): Promise<number> {
  const rows = samples.filter((s) => s.assetId && s.sampledAt instanceof Date);
  if (rows.length === 0) return 0;
  await db.insert(deviceMetrics).values(
    rows.map((s) => ({
      assetId: s.assetId,
      sampledAt: s.sampledAt,
      cpuPct: s.cpuPct,
      memPct: s.memPct,
      diskPct: s.diskPct,
      uptimeSec: s.uptimeSec,
    })),
  );
  return rows.length;
}

export interface MetricPoint {
  sampledAt: string;
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
}

export interface DeviceMetrics {
  points: MetricPoint[]; // oldest → newest, for the sparklines
  latest: {
    cpuPct: number | null;
    memPct: number | null;
    diskPct: number | null;
    uptimeSec: number | null;
    sampledAt: string;
  } | null;
}

/** The last `hours` of samples for one asset (by its human tag), oldest first, plus
   the latest reading. Empty when the device has never been sampled. */
export async function getDeviceMetrics(
  tag: string,
  hours = 24,
): Promise<DeviceMetrics> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await db
    .select({
      sampledAt: deviceMetrics.sampledAt,
      cpuPct: deviceMetrics.cpuPct,
      memPct: deviceMetrics.memPct,
      diskPct: deviceMetrics.diskPct,
      uptimeSec: deviceMetrics.uptimeSec,
    })
    .from(deviceMetrics)
    .innerJoin(assets, eq(assets.id, deviceMetrics.assetId))
    .where(and(eq(assets.tag, tag), gte(deviceMetrics.sampledAt, since)))
    .orderBy(deviceMetrics.sampledAt);

  if (rows.length === 0) return { points: [], latest: null };

  const points = rows.map((r) => ({
    sampledAt: r.sampledAt.toISOString(),
    cpuPct: r.cpuPct,
    memPct: r.memPct,
    diskPct: r.diskPct,
  }));
  const last = rows[rows.length - 1];
  return {
    points,
    latest: {
      cpuPct: last.cpuPct,
      memPct: last.memPct,
      diskPct: last.diskPct,
      uptimeSec: last.uptimeSec,
      sampledAt: last.sampledAt.toISOString(),
    },
  };
}

/** Delete samples older than the retention window; returns the count removed. */
export async function pruneMetrics(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const removed = await db
    .delete(deviceMetrics)
    .where(lt(deviceMetrics.sampledAt, cutoff))
    .returning({ id: deviceMetrics.id });
  return removed.length;
}

/** Latest CPU/RAM/disk per Computer asset — for the fleet "top talkers" view
   (phase 2). One row per asset that has at least one sample. */
export async function getLatestMetricsByAsset(): Promise<
  Map<string, { cpuPct: number | null; memPct: number | null; diskPct: number | null }>
> {
  const rows = await db
    .select({
      assetId: deviceMetrics.assetId,
      cpuPct: deviceMetrics.cpuPct,
      memPct: deviceMetrics.memPct,
      diskPct: deviceMetrics.diskPct,
      sampledAt: deviceMetrics.sampledAt,
    })
    .from(deviceMetrics)
    .where(
      // only the newest row per asset
      eq(
        deviceMetrics.sampledAt,
        sql`(select max(dm.sampled_at) from ${deviceMetrics} dm where dm.asset_id = ${deviceMetrics.assetId})`,
      ),
    );
  const out = new Map<string, { cpuPct: number | null; memPct: number | null; diskPct: number | null }>();
  for (const r of rows) {
    out.set(r.assetId, { cpuPct: r.cpuPct, memPct: r.memPct, diskPct: r.diskPct });
  }
  return out;
}
