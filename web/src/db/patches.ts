import "server-only";

import { asc, eq } from "drizzle-orm";

import { db } from "./index";
import {
  appUpgrades,
  assets,
  complianceStatus,
  people,
  windowsHotfixes,
  windowsMissingUpdates,
  windowsUpdateState,
} from "./schema";

/**
 * Windows patch inventory (spec 31). Phase 1: scan posts hotfixes / winget.
 * Phase 2: dedicated Search posts missing OS updates + fills updates_pending.
 */

function clean(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v || null;
}

/** InstalledOn → YYYY-MM-DD, or null for empty / garbage / epoch-ish WMI dates. */
function sanitizeInstalledOn(value: string | null | undefined): string | null {
  const s = clean(value);
  if (!s || s.length < 10) return null;
  const y = s.slice(0, 4);
  const m = s.slice(5, 7);
  const d = s.slice(8, 10);
  if (s[4] !== "-" || s[7] !== "-" || !/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) {
    return null;
  }
  if (Number(y) < 1990) return null;
  return `${y}-${m}-${d}`;
}

/** One hotfix as the collector posts it (snake_case). */
export type PostedHotfix = {
  id?: string | null;
  description?: string | null;
  installed_on?: string | null;
};

/** One winget upgrade as the collector posts it. */
export type PostedAppUpgrade = {
  id?: string | null;
  name?: string | null;
  version?: string | null;
  available?: string | null;
  source?: string | null;
};

/** Patch block on a HostResult (spec 31). */
export type PostedWindowsUpdates = {
  pending_reboot?: boolean | null;
  hotfixes?: PostedHotfix[] | null;
  winget_available?: boolean | null;
  app_upgrades?: PostedAppUpgrade[] | null;
  winget_detail?: string | null;
};

/**
 * Upsert current patch state for a matched Computer (AC-2).
 *
 * - Hotfixes present (array, maybe empty) → replace `windows_hotfixes`.
 * - `winget_available === true` → replace `app_upgrades` (empty clears).
 * - `winget_available === false` → store the flag, leave prior app rows (AC-8).
 * - `winget_available == null` → leave winget columns as previously stored when
 *   updating an existing row; on insert they stay null/0.
 */
export async function upsertWindowsUpdates(
  assetId: string,
  posted: PostedWindowsUpdates,
  collectedAt: Date,
): Promise<void> {
  const hotfixes = Array.isArray(posted.hotfixes) ? posted.hotfixes : null;
  const winget = posted.winget_available;
  const replaceApps = winget === true;
  const apps = replaceApps
    ? Array.isArray(posted.app_upgrades)
      ? posted.app_upgrades
      : []
    : null;

  const seenKb = new Set<string>();
  const hotfixRows =
    hotfixes == null
      ? null
      : hotfixes
          .map((h) => {
            const hotfixId = clean(h.id);
            if (!hotfixId || seenKb.has(hotfixId)) return null;
            seenKb.add(hotfixId);
            return {
              assetId,
              hotfixId,
              description: clean(h.description),
              installedOn: sanitizeInstalledOn(h.installed_on),
            };
          })
          .filter((r): r is NonNullable<typeof r> => r != null);

  const seenPkg = new Set<string>();
  const appRows =
    apps == null
      ? null
      : apps
          .map((a) => {
            const packageId = clean(a.id);
            const name = clean(a.name);
            if (!packageId || !name || seenPkg.has(packageId)) return null;
            seenPkg.add(packageId);
            return {
              assetId,
              packageId,
              name,
              version: clean(a.version),
              available: clean(a.available),
              source: clean(a.source),
            };
          })
          .filter((r): r is NonNullable<typeof r> => r != null);

  await db.transaction(async (tx) => {
    const stateInsert: {
      assetId: string;
      pendingReboot: boolean | null;
      hotfixCount: number;
      wingetAvailable?: boolean | null;
      wingetDetail?: string | null;
      appUpgradeCount?: number;
      collectedAt: Date;
    } = {
      assetId,
      pendingReboot:
        typeof posted.pending_reboot === "boolean" ? posted.pending_reboot : null,
      hotfixCount: hotfixRows?.length ?? 0,
      collectedAt,
    };
    const stateUpdate: {
      pendingReboot: boolean | null;
      hotfixCount: number;
      collectedAt: Date;
      wingetAvailable?: boolean | null;
      wingetDetail?: string | null;
      appUpgradeCount?: number;
    } = {
      pendingReboot: stateInsert.pendingReboot,
      hotfixCount: stateInsert.hotfixCount,
      collectedAt,
    };

    if (winget === true) {
      stateInsert.wingetAvailable = true;
      stateInsert.wingetDetail = null;
      stateInsert.appUpgradeCount = appRows?.length ?? 0;
      stateUpdate.wingetAvailable = true;
      stateUpdate.wingetDetail = null;
      stateUpdate.appUpgradeCount = stateInsert.appUpgradeCount;
    } else if (winget === false) {
      stateInsert.wingetAvailable = false;
      stateInsert.wingetDetail = clean(posted.winget_detail);
      stateUpdate.wingetAvailable = false;
      stateUpdate.wingetDetail = stateInsert.wingetDetail;
      // Keep prior appUpgradeCount on conflict; insert defaults to 0.
    }
    // winget == null: omit from update so a hotfix-only refresh doesn't wipe flags.

    await tx
      .insert(windowsUpdateState)
      .values(stateInsert)
      .onConflictDoUpdate({
        target: windowsUpdateState.assetId,
        set: stateUpdate,
      });

    if (hotfixRows != null) {
      await tx
        .delete(windowsHotfixes)
        .where(eq(windowsHotfixes.assetId, assetId));
      if (hotfixRows.length) {
        await tx.insert(windowsHotfixes).values(hotfixRows);
      }
    }

    if (appRows != null) {
      await tx.delete(appUpgrades).where(eq(appUpgrades.assetId, assetId));
      if (appRows.length) {
        await tx.insert(appUpgrades).values(appRows);
      }
    }
  });
}

export type PostedMissingUpdate = {
  kb?: string | null;
  title?: string | null;
  severity?: string | null;
  size_bytes?: number | null;
};

/**
 * Replace missing OS updates from a successful WUA Search (AC-11). Also sets
 * `compliance_status.updates_pending`. A gap (no Search result) never calls this.
 */
export async function replaceMissingUpdates(
  assetId: string,
  posted: PostedMissingUpdate[],
  collectedAt: Date,
): Promise<void> {
  const seen = new Set<string>();
  const rows = posted
    .map((m) => {
      const kbId = clean(m.kb);
      const title = clean(m.title);
      if (!kbId || !title || seen.has(kbId)) return null;
      seen.add(kbId);
      const size =
        typeof m.size_bytes === "number" && Number.isFinite(m.size_bytes)
          ? Math.trunc(m.size_bytes)
          : null;
      return {
        assetId,
        kbId,
        title,
        severity: clean(m.severity),
        sizeBytes: size,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  await db.transaction(async (tx) => {
    await tx
      .insert(windowsUpdateState)
      .values({
        assetId,
        pendingReboot: null,
        hotfixCount: 0,
        appUpgradeCount: 0,
        collectedAt,
        missingCount: rows.length,
        missingCollectedAt: collectedAt,
      })
      .onConflictDoUpdate({
        target: windowsUpdateState.assetId,
        set: {
          missingCount: rows.length,
          missingCollectedAt: collectedAt,
        },
      });

    await tx
      .delete(windowsMissingUpdates)
      .where(eq(windowsMissingUpdates.assetId, assetId));
    if (rows.length) {
      await tx.insert(windowsMissingUpdates).values(rows);
    }

    // Fill compliance pending count; create no posture row if none exists —
    // only update when a compliance row is already there, OR upsert just the
    // pending field via insert-on-conflict with assessedAt = collectedAt.
    await tx
      .insert(complianceStatus)
      .values({
        assetId,
        updatesPending: rows.length,
        assessedAt: collectedAt,
      })
      .onConflictDoUpdate({
        target: complianceStatus.assetId,
        set: { updatesPending: rows.length },
      });
  });
}

export type ComputerPatches = {
  pendingReboot: boolean | null;
  hotfixCount: number;
  wingetAvailable: boolean | null;
  wingetDetail: string | null;
  appUpgradeCount: number;
  collectedAt: string;
  updatesLastDays: number | null;
  missingCount: number;
  missingCollectedAt: string | null;
  hotfixes: {
    hotfixId: string;
    description: string | null;
    installedOn: string | null;
  }[];
  appUpgrades: {
    packageId: string;
    name: string;
    version: string | null;
    available: string | null;
    source: string | null;
  }[];
  missing: {
    kbId: string;
    title: string;
    severity: string | null;
    sizeBytes: number | null;
  }[];
};

/** Patch inventory for one computer by human tag. Null if never collected. */
export async function getComputerPatches(
  tag: string,
): Promise<ComputerPatches | null> {
  const [state] = await db
    .select({
      pendingReboot: windowsUpdateState.pendingReboot,
      hotfixCount: windowsUpdateState.hotfixCount,
      wingetAvailable: windowsUpdateState.wingetAvailable,
      wingetDetail: windowsUpdateState.wingetDetail,
      appUpgradeCount: windowsUpdateState.appUpgradeCount,
      collectedAt: windowsUpdateState.collectedAt,
      missingCount: windowsUpdateState.missingCount,
      missingCollectedAt: windowsUpdateState.missingCollectedAt,
      updatesLastDays: complianceStatus.updatesLastDays,
    })
    .from(windowsUpdateState)
    .innerJoin(assets, eq(assets.id, windowsUpdateState.assetId))
    .leftJoin(complianceStatus, eq(complianceStatus.assetId, assets.id))
    .where(eq(assets.tag, tag))
    .limit(1);

  if (!state) return null;

  const [kbRows, appRows, missingRows] = await Promise.all([
    db
      .select({
        hotfixId: windowsHotfixes.hotfixId,
        description: windowsHotfixes.description,
        installedOn: windowsHotfixes.installedOn,
      })
      .from(windowsHotfixes)
      .innerJoin(assets, eq(assets.id, windowsHotfixes.assetId))
      .where(eq(assets.tag, tag))
      .orderBy(asc(windowsHotfixes.hotfixId)),
    db
      .select({
        packageId: appUpgrades.packageId,
        name: appUpgrades.name,
        version: appUpgrades.version,
        available: appUpgrades.available,
        source: appUpgrades.source,
      })
      .from(appUpgrades)
      .innerJoin(assets, eq(assets.id, appUpgrades.assetId))
      .where(eq(assets.tag, tag))
      .orderBy(asc(appUpgrades.name)),
    db
      .select({
        kbId: windowsMissingUpdates.kbId,
        title: windowsMissingUpdates.title,
        severity: windowsMissingUpdates.severity,
        sizeBytes: windowsMissingUpdates.sizeBytes,
      })
      .from(windowsMissingUpdates)
      .innerJoin(assets, eq(assets.id, windowsMissingUpdates.assetId))
      .where(eq(assets.tag, tag))
      .orderBy(asc(windowsMissingUpdates.kbId)),
  ]);

  return {
    pendingReboot: state.pendingReboot,
    hotfixCount: state.hotfixCount,
    wingetAvailable: state.wingetAvailable,
    wingetDetail: state.wingetDetail,
    appUpgradeCount: state.appUpgradeCount,
    collectedAt: state.collectedAt.toISOString(),
    updatesLastDays: state.updatesLastDays,
    missingCount: state.missingCount,
    missingCollectedAt: state.missingCollectedAt
      ? state.missingCollectedAt.toISOString()
      : null,
    hotfixes: kbRows.map((r) => ({
      hotfixId: r.hotfixId,
      description: r.description,
      installedOn: r.installedOn,
    })),
    appUpgrades: appRows.map((r) => ({
      packageId: r.packageId,
      name: r.name,
      version: r.version,
      available: r.available,
      source: r.source,
    })),
    missing: missingRows.map((r) => ({
      kbId: r.kbId,
      title: r.title,
      severity: r.severity,
      sizeBytes: r.sizeBytes,
    })),
  };
}

export type FleetPatchRow = {
  tag: string;
  name: string;
  /** Current person assignment; null when unassigned (pool). */
  assigneeName: string | null;
  pendingReboot: boolean | null;
  hotfixCount: number;
  wingetAvailable: boolean | null;
  appUpgradeCount: number;
  missingCount: number;
  collectedAt: string | null;
  updatesLastDays: number | null;
};

/** Every Computer with its current patch summary for `/patches` (AC-4 / AC-12). */
export async function getFleetPatches(): Promise<FleetPatchRow[]> {
  const rows = await db
    .select({
      tag: assets.tag,
      name: assets.name,
      assigneeName: people.name,
      pendingReboot: windowsUpdateState.pendingReboot,
      hotfixCount: windowsUpdateState.hotfixCount,
      wingetAvailable: windowsUpdateState.wingetAvailable,
      appUpgradeCount: windowsUpdateState.appUpgradeCount,
      missingCount: windowsUpdateState.missingCount,
      collectedAt: windowsUpdateState.collectedAt,
      updatesLastDays: complianceStatus.updatesLastDays,
    })
    .from(assets)
    .leftJoin(people, eq(people.id, assets.assigneeId))
    .leftJoin(windowsUpdateState, eq(windowsUpdateState.assetId, assets.id))
    .leftJoin(complianceStatus, eq(complianceStatus.assetId, assets.id))
    .where(eq(assets.type, "Computer"))
    .orderBy(asc(assets.name));

  return rows.map((r) => ({
    tag: r.tag,
    name: r.name,
    assigneeName: r.assigneeName ?? null,
    pendingReboot: r.pendingReboot,
    hotfixCount: r.hotfixCount ?? 0,
    wingetAvailable: r.wingetAvailable,
    appUpgradeCount: r.appUpgradeCount ?? 0,
    missingCount: r.missingCount ?? 0,
    collectedAt: r.collectedAt ? r.collectedAt.toISOString() : null,
    updatesLastDays: r.updatesLastDays,
  }));
}
