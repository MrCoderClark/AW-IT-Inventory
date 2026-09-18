import "server-only";

import { cache } from "react";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type {
  Asset,
  AssetStatus,
  AssetType,
  DeviceSuggestion,
  DiscoveredDevice,
  LinkAsset,
  LocationNode,
  LocationOption,
  MachineSummary,
} from "@/lib/data";
import { LOCATION_PATH_SEP } from "@/lib/data";
import { db } from "./index";
import { assets, locations, machines, people } from "./schema";

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
  assigneeName: people.name,
  assigneeInitials: people.initials,
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
  assigneeName: string | null;
  assigneeInitials: string | null;
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
  };
}

/** Shared asset select + people join; callers add their own where/order/limit. */
function selectAssets() {
  return db
    .select(assetSelect)
    .from(assets)
    .leftJoin(people, eq(assets.assigneeId, people.id));
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
  return rows.map((r) => toAsset(r, pathById));
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

/** Wrapped in React.cache so the 5 category pages + dashboard + detail page
   that each load people (when the user can write) dedupe to one query per
   request instead of a round trip apiece. */
export const getPeople = cache(async function getPeople(): Promise<Person[]> {
  return db
    .select({ id: people.id, name: people.name, initials: people.initials })
    .from(people)
    .orderBy(asc(people.name));
});

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
    .innerJoin(assets, eq(machines.assetId, assets.id));

  const map: Record<string, MachineSummary> = {};
  for (const r of rows) {
    map[r.tag] = toMachineSummary(r);
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
const getLocationPathMap = cache(async function getLocationPathMap(): Promise<
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

/** One location row by id, or null. */
export async function getLocationById(id: string): Promise<LocationRaw | null> {
  const rows = await db
    .select({
      id: locations.id,
      name: locations.name,
      parentId: locations.parentId,
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
