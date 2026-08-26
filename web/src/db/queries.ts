import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import type {
  Asset,
  AssetStatus,
  AssetType,
  MachineSummary,
} from "@/lib/data";
import { db } from "./index";
import { assets, machines, people } from "./schema";

function toDateStr(value: Date | string | null): string {
  if (!value) return "";
  return typeof value === "string"
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}

const assetSelect = {
  tag: assets.tag,
  name: assets.name,
  type: assets.type,
  serial: assets.serial,
  model: assets.model,
  location: assets.location,
  status: assets.status,
  lastSync: assets.lastSync,
  vendor: assets.vendor,
  purchaseDate: assets.purchaseDate,
  warrantyUntil: assets.warrantyUntil,
  costCenter: assets.costCenter,
  spec: assets.spec,
  assigneeName: people.name,
  assigneeInitials: people.initials,
};

type Row = {
  tag: string;
  name: string;
  type: string;
  serial: string | null;
  model: string | null;
  location: string | null;
  status: string;
  lastSync: Date | string | null;
  vendor: string | null;
  purchaseDate: string | null;
  warrantyUntil: string | null;
  costCenter: string | null;
  spec: string | null;
  assigneeName: string | null;
  assigneeInitials: string | null;
};

function toAsset(r: Row): Asset {
  return {
    id: r.tag,
    name: r.name,
    type: r.type as AssetType,
    serial: r.serial ?? "",
    model: r.model ?? "",
    assignee: r.assigneeName
      ? { name: r.assigneeName, initials: r.assigneeInitials ?? "" }
      : null,
    location: r.location ?? "",
    status: r.status as AssetStatus,
    lastSync: toDateStr(r.lastSync),
    vendor: r.vendor ?? "",
    purchaseDate: r.purchaseDate ?? "",
    warrantyUntil: r.warrantyUntil ?? "",
    costCenter: r.costCenter ?? "",
    spec: r.spec ?? "",
  };
}

export async function getAssets(): Promise<Asset[]> {
  const rows = await db
    .select(assetSelect)
    .from(assets)
    .leftJoin(people, eq(assets.assigneeId, people.id))
    .orderBy(asc(assets.tag));
  return rows.map(toAsset);
}

/** Latest live-scan summary per matched asset, keyed by asset tag. */
export async function getMachineSummaries(): Promise<
  Record<string, MachineSummary>
> {
  const rows = await db
    .select({
      tag: assets.tag,
      lastSeenAt: machines.lastSeenAt,
      osName: machines.osName,
      osVersion: machines.osVersion,
      hardware: machines.hardware,
      health: machines.health,
      status: machines.lastScanStatus,
    })
    .from(machines)
    .innerJoin(assets, eq(machines.assetId, assets.id));

  const map: Record<string, MachineSummary> = {};
  for (const r of rows) {
    const hw = (r.hardware ?? {}) as Record<string, unknown>;
    const health = (r.health ?? {}) as Record<string, unknown>;
    const freeMap = health.free_disk_gb as Record<string, number> | undefined;
    const firstFree =
      freeMap && typeof freeMap === "object"
        ? Number(Object.values(freeMap)[0])
        : null;

    map[r.tag] = {
      lastSeen: r.lastSeenAt ? toDateStr(r.lastSeenAt) : "",
      osName: (r.osName ?? (health.os_name as string) ?? "") || "",
      osVersion: (r.osVersion ?? (health.os_version as string) ?? "") || "",
      cpu: (hw.cpu as string) ?? "",
      ramGb: typeof hw.ram_gb === "number" ? (hw.ram_gb as number) : null,
      freeDiskGb: Number.isFinite(firstFree) ? firstFree : null,
      uptimeHours:
        typeof health.uptime_hours === "number"
          ? (health.uptime_hours as number)
          : null,
      status: r.status ?? "ok",
    };
  }
  return map;
}

export interface DashboardStats {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [typeRows, statusRows] = await Promise.all([
    db
      .select({ key: assets.type, count: sql<number>`count(*)::int` })
      .from(assets)
      .groupBy(assets.type),
    db
      .select({ key: assets.status, count: sql<number>`count(*)::int` })
      .from(assets)
      .groupBy(assets.status),
  ]);

  const byType = Object.fromEntries(typeRows.map((r) => [r.key, r.count]));
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.key, r.count]));
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  return { total, byType, byStatus };
}
