import "server-only";

import { cache } from "react";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type {
  Asset,
  AssetReachability,
  AssetStatus,
  AssetType,
  DeviceSuggestion,
  DiscoveredDevice,
  LinkAsset,
  LocationCount,
  LocationMapPoint,
  LocationNode,
  LocationOption,
  MachineSummary,
  ReachabilityCheck,
  RecentAsset,
} from "@/lib/data";
import { LOCATION_PATH_SEP } from "@/lib/data";
import type { ColumnView } from "@/lib/table-columns";
import { db } from "./index";
import {
  assets,
  computerDetails,
  locations,
  machines,
  media,
  monitorDetails,
  networkDetails,
  people,
  phoneDetails,
  printerChecks,
  printerCounters,
  printerDetails,
  printerStatus,
  tableColumnConfig,
} from "./schema";

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
  locationId: assets.locationId,
  status: assets.status,
  lastSync: assets.lastSync,
  vendor: assets.vendor,
  purchaseDate: assets.purchaseDate,
  warrantyUntil: assets.warrantyUntil,
  costCenter: assets.costCenter,
  spec: assets.spec,
  imageId: assets.imageId,
  // Cut-out display state (spec 18 phase 3) for the image cache-buster: the asset
  // image route serves the cut-out when `preferCutout` is on, so the version token
  // must change when that (or the cut-out itself) changes.
  imagePreferCutout: media.preferCutout,
  imageCutoutKey: media.cutoutKey,
  imageCutoutAttempts: media.cutoutAttempts,
  assigneeName: people.name,
  assigneeInitials: people.initials,
  // Searchable identifiers from the type detail tables (only one type ever has a
  // row per asset, so at most one set is non-null). See spec 10 AC-5.
  computerIp: computerDetails.ipAddress,
  printerIp: printerDetails.ipAddress,
  phoneImei: phoneDetails.imei,
  phoneNumber: phoneDetails.phoneNumber,
  networkIp: networkDetails.ipAddress,
  networkMac: networkDetails.macAddress,
};

type Row = {
  tag: string;
  name: string;
  type: string;
  serial: string | null;
  model: string | null;
  locationId: string | null;
  status: string;
  lastSync: Date | string | null;
  vendor: string | null;
  purchaseDate: string | null;
  warrantyUntil: string | null;
  costCenter: string | null;
  spec: string | null;
  imageId: string | null;
  imagePreferCutout: boolean | null;
  imageCutoutKey: string | null;
  imageCutoutAttempts: number | null;
  assigneeName: string | null;
  assigneeInitials: string | null;
  computerIp: string | null;
  printerIp: string | null;
  phoneImei: string | null;
  phoneNumber: string | null;
  networkIp: string | null;
  networkMac: string | null;
};

/** Map a row to a display Asset. `pathById` resolves the assigned leaf's id to
   its full path (empty when the asset has no location). */
function toAsset(r: Row, pathById: Map<string, string>): Asset {
  return {
    id: r.tag,
    name: r.name,
    type: r.type as AssetType,
    serial: r.serial ?? "",
    model: r.model ?? "",
    assignee: r.assigneeName
      ? { name: r.assigneeName, initials: r.assigneeInitials ?? "" }
      : null,
    location: r.locationId ? pathById.get(r.locationId) ?? "" : "",
    locationId: r.locationId,
    status: r.status as AssetStatus,
    lastSync: toDateStr(r.lastSync),
    vendor: r.vendor ?? "",
    purchaseDate: r.purchaseDate ?? "",
    warrantyUntil: r.warrantyUntil ?? "",
    costCenter: r.costCenter ?? "",
    spec: r.spec ?? "",
    imageId: r.imageId ?? null,
    // Cache-buster for the asset image: changes when the asset points at a
    // different image, when the cut-out is toggled on/off, or when it's redone.
    imageVersion: r.imageId
      ? `${r.imageId}:${
          r.imagePreferCutout && r.imageCutoutKey
            ? `c${r.imageCutoutAttempts ?? 0}`
            : "o"
        }`
      : null,
    search: [
      r.computerIp,
      r.printerIp,
      r.phoneImei,
      r.phoneNumber,
      r.networkIp,
      r.networkMac,
    ]
      .filter(Boolean)
      .join(" "),
    ip: r.printerIp ?? r.networkIp ?? r.computerIp ?? "",
    mac: r.networkMac ?? "",
    phoneNumber: r.phoneNumber ?? "",
  };
}

/** Shared asset select + people join + the detail tables that hold searchable
   identifiers; callers add their own where/order/limit. */
function selectAssets() {
  return db
    .select(assetSelect)
    .from(assets)
    .leftJoin(people, eq(assets.assigneeId, people.id))
    .leftJoin(media, eq(assets.imageId, media.id))
    .leftJoin(computerDetails, eq(assets.id, computerDetails.assetId))
    .leftJoin(printerDetails, eq(assets.id, printerDetails.assetId))
    .leftJoin(phoneDetails, eq(assets.id, phoneDetails.assetId))
    .leftJoin(networkDetails, eq(assets.id, networkDetails.assetId));
}

/** A location-filter option: restrict to assets in a chosen location's subtree
   (a parent includes every descendant leaf). Undefined/absent = all assets. */
export interface AssetFilter {
  locationId?: string | null;
}

/** Resolve the location filter to a set of leaf ids, or null for "no filter".
   Uses the shared subtree helper so the filter and the tree guards agree. */
async function resolveLocationFilter(
  filter?: AssetFilter,
): Promise<string[] | null> {
  const id = filter?.locationId;
  if (!id) return null;
  return getSubtreeIds(id);
}

export async function getAssets(filter?: AssetFilter): Promise<Asset[]> {
  const subtree = await resolveLocationFilter(filter);
  if (subtree && subtree.length === 0) return [];
  const [rows, pathById] = await Promise.all([
    selectAssets()
      .where(subtree ? inArray(assets.locationId, subtree) : undefined)
      .orderBy(asc(assets.tag)),
    getLocationPathMap(),
  ]);
  return rows.map((r) => toAsset(r, pathById));
}

/** Assets of a single category, for the per-type list pages. */
export async function getAssetsByType(
  type: AssetType,
  filter?: AssetFilter,
): Promise<Asset[]> {
  const subtree = await resolveLocationFilter(filter);
  if (subtree && subtree.length === 0) return [];
  const [rows, pathById] = await Promise.all([
    selectAssets()
      .where(
        subtree
          ? and(eq(assets.type, type), inArray(assets.locationId, subtree))
          : eq(assets.type, type),
      )
      .orderBy(asc(assets.tag)),
    getLocationPathMap(),
  ]);
  const list = rows.map((r) => toAsset(r, pathById));

  // Printers carry a reachability rollup for the badge column (spec 12, AC-8) and
  // their latest page counter for the Pages column (spec 14).
  if (type === "Printer" && list.length > 0) {
    const [reach, pages] = await Promise.all([
      getPrinterReachabilityMap(),
      getPrinterCounterMap(),
    ]);
    for (const a of list) {
      const r = reach[a.id];
      if (r) a.reachability = r;
      const p = pages[a.id];
      if (p !== undefined) a.pageCount = p;
    }
  }
  return list;
}

/** Latest total page counter per printer, keyed by asset tag (spec 14). One row
   per printer: the most recent daily reading (DISTINCT ON the asset, newest day
   first). Printers with no reading are simply absent from the map. */
export async function getPrinterCounterMap(): Promise<Record<string, number>> {
  const rows = await db
    .selectDistinctOn([printerCounters.assetId], {
      tag: assets.tag,
      total: printerCounters.totalPages,
    })
    .from(printerCounters)
    .innerJoin(assets, eq(assets.id, printerCounters.assetId))
    .orderBy(printerCounters.assetId, desc(printerCounters.readingDate));
  const out: Record<string, number> = {};
  for (const r of rows) out[r.tag] = r.total;
  return out;
}

/** Map a printer_status row to the display reachability rollup (spec 12). A null
   `reachable` (a row that exists but was never resolved) reads as "unknown". */
function toReachability(row: {
  reachable: boolean | null;
  isDown: boolean;
  lastCheckedAt: Date | string | null;
  downSince: Date | string | null;
}): AssetReachability {
  const iso = (v: Date | string | null) =>
    v ? (typeof v === "string" ? v : v.toISOString()) : null;
  if (row.reachable === null) {
    return { state: "unknown", lastCheckedAt: iso(row.lastCheckedAt), downSince: null };
  }
  return {
    state: row.isDown ? "down" : "up",
    lastCheckedAt: iso(row.lastCheckedAt),
    downSince: iso(row.downSince),
  };
}

/** Reachability rollups for every printer, keyed by asset tag (spec 12, AC-8). */
export async function getPrinterReachabilityMap(): Promise<
  Record<string, AssetReachability>
> {
  const rows = await db
    .select({
      tag: assets.tag,
      reachable: printerStatus.reachable,
      isDown: printerStatus.isDown,
      lastCheckedAt: printerStatus.lastCheckedAt,
      downSince: printerStatus.downSince,
    })
    .from(printerStatus)
    .innerJoin(assets, eq(assets.id, printerStatus.assetId));
  const out: Record<string, AssetReachability> = {};
  for (const r of rows) out[r.tag] = toReachability(r);
  return out;
}

/**
 * The reachability rollup plus recent check history for one printer's detail
 * page (spec 12, AC-8). `tag` is the human asset id. Returns null when the tag
 * is not a printer; the status is "unknown" until the first check lands.
 */
export async function getPrinterReachability(
  tag: string,
  historyLimit = 10,
): Promise<{ status: AssetReachability; history: ReachabilityCheck[] } | null> {
  const [a] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.tag, tag), eq(assets.type, "Printer")))
    .limit(1);
  if (!a) return null;

  const [statusRow] = await db
    .select({
      reachable: printerStatus.reachable,
      isDown: printerStatus.isDown,
      lastCheckedAt: printerStatus.lastCheckedAt,
      downSince: printerStatus.downSince,
    })
    .from(printerStatus)
    .where(eq(printerStatus.assetId, a.id))
    .limit(1);

  const historyRows = await db
    .select({
      checkedAt: printerChecks.checkedAt,
      reachable: printerChecks.reachable,
      latencyMs: printerChecks.latencyMs,
      method: printerChecks.method,
    })
    .from(printerChecks)
    .where(eq(printerChecks.assetId, a.id))
    .orderBy(desc(printerChecks.checkedAt))
    .limit(historyLimit);

  return {
    status: statusRow
      ? toReachability(statusRow)
      : { state: "unknown", lastCheckedAt: null, downSince: null },
    history: historyRows.map((r) => ({
      checkedAt: r.checkedAt.toISOString(),
      reachable: r.reachable,
      latencyMs: r.latencyMs,
      method: r.method,
    })),
  };
}

/**
 * The saved column layout for a view, or `null` when none is saved (spec 11).
 * `null` tells the table to fall back to the code-owned defaults. Read fresh per
 * request (no cache), so a save + `revalidatePath` is enough for every user to
 * see a new layout on their next load.
 */
export async function getColumnConfig(
  view: ColumnView,
): Promise<string[] | null> {
  const [row] = await db
    .select({ columns: tableColumnConfig.columns })
    .from(tableColumnConfig)
    .where(eq(tableColumnConfig.viewKey, view))
    .limit(1);
  if (!row) return null;
  return Array.isArray(row.columns) ? row.columns : null;
}

/** One asset by its human tag (the UI `id`), or null if none matches. */
export async function getAssetById(id: string): Promise<Asset | null> {
  const [rows, pathById] = await Promise.all([
    selectAssets().where(eq(assets.tag, id)).limit(1),
    getLocationPathMap(),
  ]);
  const row = rows[0];
  return row ? toAsset(row, pathById) : null;
}

/** People for the assignee picker on the asset form. */
export interface Person {
  id: string;
  name: string;
  initials: string;
}

/** People for the assignee picker: ACTIVE only (spec 16, AC-8 — the picker never
   offers an archived person). Wrapped in React.cache so the 5 category pages +
   dashboard + detail page that each load people (when the user can write) dedupe
   to one query per request instead of a round trip apiece. */
export const getPeople = cache(async function getPeople(): Promise<Person[]> {
  return db
    .select({ id: people.id, name: people.name, initials: people.initials })
    .from(people)
    .where(eq(people.status, "active"))
    .orderBy(asc(people.name));
});

/** A device that can be handed to a person, for the person-page assign picker
   (spec 16). Only types that carry an assignee (Computer/Monitor/Phone; printers
   and network gear are never person-assigned). */
export interface AssignableAsset {
  tag: string;
  name: string;
  type: AssetType;
}

/** Assignable devices for the person-page assign picker, ordered by name. */
export async function getAssignableAssets(): Promise<AssignableAsset[]> {
  const rows = await db
    .select({ tag: assets.tag, name: assets.name, type: assets.type })
    .from(assets)
    .where(inArray(assets.type, ["Computer", "Monitor", "Phone"]))
    .orderBy(asc(assets.name));
  return rows.map((r) => ({
    tag: r.tag,
    name: r.name,
    type: r.type as AssetType,
  }));
}

/**
 * The current assignee id for one asset tag, so the edit form can pre-select
 * the right person (the display `Asset` only carries the assignee's name). Null
 * when unassigned, undefined when the tag matches no asset.
 */
export async function getAssetAssigneeId(
  tag: string,
): Promise<string | null | undefined> {
  const rows = await db
    .select({ assigneeId: assets.assigneeId })
    .from(assets)
    .where(eq(assets.tag, tag))
    .limit(1);
  return rows.length ? rows[0].assigneeId : undefined;
}

function detailTableFor(type: AssetType) {
  switch (type) {
    case "Computer":
      return computerDetails;
    case "Monitor":
      return monitorDetails;
    case "Printer":
      return printerDetails;
    case "Phone":
      return phoneDetails;
    case "Network":
      return networkDetails;
  }
}

export interface AssetDetails {
  type: AssetType;
  /** The type's detail row, or null when the asset has no detail row yet. */
  row: Record<string, unknown> | null;
}

/**
 * The type-specific detail row for one asset tag, plus the asset's type, for the
 * edit prefill and the detail page. Null when the tag matches no asset; `row` is
 * null when the asset exists but has no detail row yet (created on first edit).
 */
export async function getAssetDetails(tag: string): Promise<AssetDetails | null> {
  const a = await db
    .select({ id: assets.id, type: assets.type })
    .from(assets)
    .where(eq(assets.tag, tag))
    .limit(1);
  if (!a.length) return null;

  const type = a[0].type as AssetType;
  // The concrete table object is correct; the cast only satisfies the union type.
  const table = detailTableFor(type) as typeof printerDetails;
  const rows = await db
    .select()
    .from(table)
    .where(eq(table.assetId, a[0].id))
    .limit(1);
  return { type, row: (rows[0] as Record<string, unknown>) ?? null };
}

const machineSummarySelect = {
  tag: assets.tag,
  lastSeenAt: machines.lastSeenAt,
  osName: machines.osName,
  osVersion: machines.osVersion,
  hardware: machines.hardware,
  health: machines.health,
  status: machines.lastScanStatus,
};

type MachineSummaryRow = {
  tag: string;
  lastSeenAt: Date | string | null;
  osName: string | null;
  osVersion: string | null;
  hardware: unknown;
  health: unknown;
  status: string | null;
};

function toMachineSummary(r: MachineSummaryRow): MachineSummary {
  const hw = (r.hardware ?? {}) as Record<string, unknown>;
  const health = (r.health ?? {}) as Record<string, unknown>;
  const freeMap = health.free_disk_gb as Record<string, number> | undefined;
  const firstFree =
    freeMap && typeof freeMap === "object"
      ? Number(Object.values(freeMap)[0])
      : null;

  return {
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

/** Latest live-scan summary for one asset tag, or undefined when unmatched.
   A scoped query (one row), not a full-fleet scan filtered in Node. */
export async function getMachineSummary(
  id: string,
): Promise<MachineSummary | undefined> {
  const rows = await db
    .select(machineSummarySelect)
    .from(machines)
    .innerJoin(assets, eq(machines.assetId, assets.id))
    .where(eq(assets.tag, id))
    // An asset can have more than one machine row (e.g. a failed scan keyed by IP
    // plus a successful one keyed by hardware UUID/serial). Show the latest scan.
    .orderBy(desc(machines.lastSeenAt))
    .limit(1);
  return rows[0] ? toMachineSummary(rows[0]) : undefined;
}

/** Latest live-scan summary per matched asset, keyed by asset tag. */
export async function getMachineSummaries(): Promise<
  Record<string, MachineSummary>
> {
  const rows = await db
    .select(machineSummarySelect)
    .from(machines)
    .innerJoin(assets, eq(machines.assetId, assets.id))
    // Oldest first, so when an asset has more than one machine row the newest scan
    // is written last and wins (see getMachineSummary).
    .orderBy(asc(machines.lastSeenAt));

  const map: Record<string, MachineSummary> = {};
  for (const r of rows) {
    map[r.tag] = toMachineSummary(r);
  }
  return map;
}

/** A computer the collector's scheduled sweep should scan: its asset id and the
   manually-entered IP (computer_details.ipAddress). */
export type ComputerScanTarget = { assetId: string; ipAddress: string };

/** Every Computer asset with a manually-entered IP — the targets for the worker's
   scheduled computer sweep. Only explicitly-entered IPs (not discovered), so the
   sweep scans exactly the machines an admin added, never a subnet. */
export async function listComputerScanTargets(): Promise<ComputerScanTarget[]> {
  const rows = await db
    .select({
      assetId: computerDetails.assetId,
      ipAddress: computerDetails.ipAddress,
    })
    .from(computerDetails)
    .innerJoin(assets, eq(assets.id, computerDetails.assetId))
    .where(eq(assets.type, "Computer"));
  return rows.filter(
    (r): r is ComputerScanTarget => !!r.ipAddress && r.ipAddress.trim().length > 0,
  );
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

/** The most-recently-updated assets, for the dashboard "Recent Assets" table. */
export async function getRecentAssets(limit = 8): Promise<RecentAsset[]> {
  const [rows, pathById] = await Promise.all([
    db
      .select({
        tag: assets.tag,
        name: assets.name,
        type: assets.type,
        status: assets.status,
        locationId: assets.locationId,
        updatedAt: assets.updatedAt,
      })
      .from(assets)
      .orderBy(desc(assets.updatedAt))
      .limit(limit),
    getLocationPathMap(),
  ]);
  return rows.map((r) => ({
    tag: r.tag,
    name: r.name,
    type: r.type as AssetType,
    location: r.locationId ? pathById.get(r.locationId) ?? "" : "",
    status: r.status as AssetStatus,
    updatedAt:
      r.updatedAt instanceof Date
        ? r.updatedAt.toISOString()
        : new Date(r.updatedAt).toISOString(),
  }));
}

/** The locations holding the most devices, for the dashboard "Assets by Location"
   card (replaces the mock's geo map — OPUS has no device coordinates). */
export async function getAssetsByLocation(limit = 6): Promise<LocationCount[]> {
  const [counts, pathById] = await Promise.all([
    locationDeviceCounts(),
    getLocationPathMap(),
  ]);
  return [...counts.entries()]
    .map(([id, count]) => ({ id, name: pathById.get(id) ?? "—", count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Geocoded locations for the dashboard map (spec: dashboard map). Each located
   location carries the device count of its whole subtree (self + descendants), so
   a building's pin reflects every device under it, not just those on its own node. */
export async function getLocationMapPoints(): Promise<LocationMapPoint[]> {
  const [located, allRows, counts, pathById] = await Promise.all([
    db
      .select({
        id: locations.id,
        lat: locations.latitude,
        lng: locations.longitude,
      })
      .from(locations)
      .where(
        and(isNotNull(locations.latitude), isNotNull(locations.longitude)),
      ),
    getLocationRows(),
    locationDeviceCounts(),
    getLocationPathMap(),
  ]);
  if (located.length === 0) return [];

  // Adjacency so a located node can sum its whole subtree's device counts.
  const children = new Map<string, string[]>();
  for (const r of allRows) {
    if (r.parentId) {
      const arr = children.get(r.parentId) ?? [];
      arr.push(r.id);
      children.set(r.parentId, arr);
    }
  }
  const subtreeCount = (rootId: string): number => {
    let sum = counts.get(rootId) ?? 0;
    const stack = [...(children.get(rootId) ?? [])];
    while (stack.length) {
      const id = stack.pop() as string;
      sum += counts.get(id) ?? 0;
      const kids = children.get(id);
      if (kids) stack.push(...kids);
    }
    return sum;
  };

  return located.map((l) => ({
    id: l.id,
    name: pathById.get(l.id) ?? "—",
    lat: l.lat as number,
    lng: l.lng as number,
    count: subtreeCount(l.id),
  }));
}

/* ---------------- Locations (the location tree) ----------------
   Adjacency list: each row carries its own `parentId`. Paths, depth and
   leaf-ness are derived in Node from the (small) flat row set; subtree
   membership is the one recursive query, shared by the list filter and the
   move guard. */

interface LocationRaw {
  id: string;
  name: string;
  parentId: string | null;
}

/** All locations, flat. Cached per request so the tree, the path map, the
   options and the pickers that a single page loads dedupe to one query. */
const getLocationRows = cache(async function getLocationRows(): Promise<
  LocationRaw[]
> {
  return db
    .select({
      id: locations.id,
      name: locations.name,
      parentId: locations.parentId,
    })
    .from(locations)
    .orderBy(asc(locations.name));
});

interface LocationIndex {
  pathById: Map<string, string>;
  depthById: Map<string, number>;
  childCount: Map<string, number>;
}

/** Resolve every row's full path ("New York / Bronx"), depth and child count
   from the flat set. Guarded against a malformed cycle (the actions prevent
   cycles, but a defensive break keeps a bad row from looping forever). */
function buildLocationIndex(rows: LocationRaw[]): LocationIndex {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childCount = new Map<string, number>();
  for (const r of rows) {
    if (r.parentId) childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
  }

  const pathById = new Map<string, string>();
  const depthById = new Map<string, number>();

  function resolve(id: string, stack: Set<string>): { path: string; depth: number } {
    const cached = pathById.get(id);
    if (cached !== undefined) return { path: cached, depth: depthById.get(id) ?? 0 };

    const row = byId.get(id);
    if (!row) return { path: "", depth: 0 };

    if (!row.parentId || stack.has(id)) {
      pathById.set(id, row.name);
      depthById.set(id, 0);
      return { path: row.name, depth: 0 };
    }

    stack.add(id);
    const parent = resolve(row.parentId, stack);
    stack.delete(id);
    const path = parent.path
      ? `${parent.path}${LOCATION_PATH_SEP}${row.name}`
      : row.name;
    const depth = parent.depth + 1;
    pathById.set(id, path);
    depthById.set(id, depth);
    return { path, depth };
  }

  for (const r of rows) resolve(r.id, new Set());
  return { pathById, depthById, childCount };
}

/** Map every location id to its full display path. */
export const getLocationPathMap = cache(async function getLocationPathMap(): Promise<
  Map<string, string>
> {
  const rows = await getLocationRows();
  return buildLocationIndex(rows).pathById;
});

/** Devices assigned per location id (only leaves ever hold devices). */
async function locationDeviceCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({ locationId: assets.locationId, count: sql<number>`count(*)::int` })
    .from(assets)
    .where(isNotNull(assets.locationId))
    .groupBy(assets.locationId);
  return new Map(rows.map((r) => [r.locationId as string, r.count]));
}

/** The whole location tree as nested nodes, each carrying its device count.
   Children (and roots) are sorted by name. Gated on `asset:read` at the page. */
export async function getLocationTree(): Promise<LocationNode[]> {
  const [rows, counts] = await Promise.all([
    getLocationRows(),
    locationDeviceCounts(),
  ]);

  const nodeById = new Map<string, LocationNode>();
  for (const r of rows) {
    nodeById.set(r.id, {
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      deviceCount: counts.get(r.id) ?? 0,
      children: [],
    });
  }

  const roots: LocationNode[] = [];
  for (const r of rows) {
    const node = nodeById.get(r.id)!;
    const parent = r.parentId ? nodeById.get(r.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRec = (list: LocationNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** All locations as flat options (path, depth, isLeaf), sorted by path. Used by
   the list filter (all) and the move picker. */
export async function getLocationOptions(): Promise<LocationOption[]> {
  const rows = await getLocationRows();
  const idx = buildLocationIndex(rows);
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      path: idx.pathById.get(r.id) ?? r.name,
      depth: idx.depthById.get(r.id) ?? 0,
      isLeaf: (idx.childCount.get(r.id) ?? 0) === 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Leaf locations only (assignable), for the asset-form location picker. */
export async function getLeafLocationOptions(): Promise<LocationOption[]> {
  return (await getLocationOptions()).filter((o) => o.isLeaf);
}

/**
 * Ids of a location and its whole subtree, via a single recursive query. The
 * one definition of "everything under here", shared by the asset list filter
 * (AC-8) and the move cycle guard (AC-4). Returns just the root id for a leaf,
 * and [] for an id that doesn't exist.
 */
export async function getSubtreeIds(rootId: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM ${locations} WHERE id = ${rootId}
      UNION ALL
      SELECT l.id FROM ${locations} l
      JOIN subtree s ON l.parent_id = s.id
    )
    SELECT id FROM subtree
  `);
  const rows = result as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export interface LocationDetail extends LocationRaw {
  latitude: number | null;
  longitude: number | null;
}

/** One location row by id (with its map coordinates), or null. */
export async function getLocationById(
  id: string,
): Promise<LocationDetail | null> {
  const rows = await db
    .select({
      id: locations.id,
      name: locations.name,
      parentId: locations.parentId,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Whether a location has any child locations (i.e. is not a leaf). */
export async function locationHasChildren(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.parentId, id))
    .limit(1);
  return rows.length > 0;
}

/** Whether any device is assigned directly to a location. */
export async function locationHasDevices(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.locationId, id))
    .limit(1);
  return rows.length > 0;
}

/**
 * Assignability of a location as a leaf target: `missing` when it doesn't
 * exist, `parent` when it has children (not assignable), `leaf` when a device
 * may be assigned to it. Drives the asset-form leaf check (AC-6, AC-11).
 */
export async function locationLeafStatus(
  id: string,
): Promise<"missing" | "parent" | "leaf"> {
  const loc = await getLocationById(id);
  if (!loc) return "missing";
  return (await locationHasChildren(id)) ? "parent" : "leaf";
}

/** Whether a sibling under `parentId` already has this exact name (optionally
   ignoring one id, for a rename). Backs the clean duplicate-name error; the
   partial unique indexes are the hard guarantee against a race. */
export async function siblingNameTaken(
  parentId: string | null,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const conds = [
    parentId === null
      ? isNull(locations.parentId)
      : eq(locations.parentId, parentId),
    eq(locations.name, name),
  ];
  if (exceptId) conds.push(ne(locations.id, exceptId));
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(...conds))
    .limit(1);
  return rows.length > 0;
}
