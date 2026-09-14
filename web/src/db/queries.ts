import "server-only";

import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type {
  Asset,
  AssetStatus,
  AssetType,
  DeviceSuggestion,
  DiscoveredDevice,
  LinkAsset,
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

/* ---------------- Discovered-devices inbox ---------------- */

/** Minimal asset list for the manual "link to existing asset" picker. */
export async function getLinkAssets(): Promise<LinkAsset[]> {
  const rows = await db
    .select({
      id: assets.id,
      tag: assets.tag,
      name: assets.name,
      type: assets.type,
      serial: assets.serial,
    })
    .from(assets)
    .orderBy(asc(assets.name));
  return rows.map((r) => ({
    id: r.id,
    tag: r.tag,
    name: r.name,
    type: r.type as AssetType,
    serial: r.serial ?? "",
  }));
}

/** Strip a domain suffix and lowercase, e.g. "PC-01.corp.local" -> "pc-01". */
function hostBase(hostname: string): string {
  return hostname.toLowerCase().split(".")[0]?.trim() ?? "";
}

function specSummary(hardware: unknown): string {
  const hw = (hardware ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof hw.cpu === "string" && hw.cpu) parts.push(hw.cpu);
  if (typeof hw.ram_gb === "number") parts.push(`${hw.ram_gb} GB RAM`);
  return parts.join(" · ");
}

const STRENGTH_ORDER: Record<DeviceSuggestion["strength"], number> = {
  exact: 3,
  strong: 2,
  weak: 1,
};

/**
 * Rank up to 3 existing assets a discovered device probably is. Computed at
 * read time (not stored): exact serial wins, then a fuzzy hostname/serial
 * match. Assets carry no network fields, so a subnet tier isn't computable;
 * a device with no plausible match returns none.
 */
function rankSuggestions(
  device: { hostname: string; serial: string },
  candidates: LinkAsset[],
): DeviceSuggestion[] {
  const serial = device.serial.trim().toLowerCase();
  const host = hostBase(device.hostname);
  const byAsset = new Map<string, DeviceSuggestion>();

  const consider = (
    a: LinkAsset,
    strength: DeviceSuggestion["strength"],
    reason: string,
  ) => {
    const existing = byAsset.get(a.id);
    if (existing && STRENGTH_ORDER[existing.strength] >= STRENGTH_ORDER[strength])
      return;
    byAsset.set(a.id, {
      assetId: a.id,
      tag: a.tag,
      name: a.name,
      type: a.type,
      serial: a.serial,
      reason,
      strength,
    });
  };

  for (const a of candidates) {
    const aSerial = a.serial.trim().toLowerCase();
    const aName = a.name.toLowerCase();

    if (serial && aSerial && serial === aSerial) {
      consider(a, "exact", "Exact serial match");
      continue;
    }
    // Fuzzy: hostname appears in the asset name, or serials share a chunk.
    if (host && host.length >= 3 && aName.includes(host)) {
      consider(a, "strong", "Hostname match");
    } else if (
      serial &&
      aSerial &&
      serial.length >= 4 &&
      (aSerial.includes(serial) || serial.includes(aSerial))
    ) {
      consider(a, "weak", "Similar serial");
    }
  }

  return [...byAsset.values()]
    .sort((x, y) => STRENGTH_ORDER[y.strength] - STRENGTH_ORDER[x.strength])
    .slice(0, 3);
}

/**
 * Devices seen on the wire with no managed asset yet (`assetId IS NULL`).
 * `includeIgnored: false` returns the active inbox (`ignoredAt IS NULL`) with
 * ranked suggestions; `true` returns the dismissed devices (`ignoredAt` set),
 * which only need a Restore action, so suggestions are skipped.
 */
export async function getDiscoveredDevices({
  includeIgnored,
}: {
  includeIgnored: boolean;
}): Promise<DiscoveredDevice[]> {
  const rows = await db
    .select({
      id: machines.id,
      hostname: machines.hostname,
      ip: machines.ip,
      subnet: machines.subnet,
      kind: machines.kind,
      serial: machines.serial,
      osName: machines.osName,
      osVersion: machines.osVersion,
      hardware: machines.hardware,
      lastSeenAt: machines.lastSeenAt,
      ignoredAt: machines.ignoredAt,
    })
    .from(machines)
    .where(
      and(
        isNull(machines.assetId),
        includeIgnored
          ? isNotNull(machines.ignoredAt)
          : isNull(machines.ignoredAt),
      ),
    )
    .orderBy(desc(machines.lastSeenAt));

  const candidates = includeIgnored ? [] : await getLinkAssets();

  return rows.map((r) => {
    const hostname = r.hostname ?? "";
    const serial = r.serial ?? "";
    return {
      id: r.id,
      hostname,
      ip: r.ip ?? "",
      subnet: r.subnet ?? "",
      kind: r.kind,
      os: [r.osName, r.osVersion].filter(Boolean).join(" "),
      serial,
      spec: specSummary(r.hardware),
      lastSeen: r.lastSeenAt ? toDateStr(r.lastSeenAt) : "",
      ignored: r.ignoredAt != null,
      suggestions: includeIgnored
        ? []
        : rankSuggestions({ hostname, serial }, candidates),
    };
  });
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
