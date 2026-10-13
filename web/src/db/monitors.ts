import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "./index";
import {
  assets,
  connectedMonitors,
  dismissedMonitors,
  monitorDetails,
} from "./schema";
import { assignAssetTx } from "./assignments";
import { isExternalMonitor, vendorName } from "@/lib/pnp-vendors";
import { generateTag } from "@/lib/tags";

/**
 * Connected displays per Computer (spec 25). Stored as current state and fully
 * replaced on each scan (like `installed_software`); the PnP vendor code is mapped
 * to a name at write time. Reads surface the Displays card; the serial is the join
 * key to Monitor assets (phase 2). Everything here is server-only.
 */

/** One display as the collector posts it (snake_case from the EDID decode). */
export type PostedMonitor = {
  vendor_code?: string | null;
  model?: string | null;
  serial?: string | null;
  product_code?: string | null;
  year?: number | null;
  active?: boolean | null;
  diagonal_in?: number | null;
  resolution?: string | null; // native, from EDID
  refresh_hz?: number | null; // native, from EDID
};

/**
 * Replace a Computer's connected displays with this scan's set (AC-3). The whole
 * set for the asset is deleted and reinserted in a transaction, so this is current
 * state. An empty array clears it (read OK, no displays); callers pass the array
 * only for a Computer that actually reported one.
 */
export async function replaceConnectedMonitors(
  assetId: string,
  posted: PostedMonitor[],
  seenAt: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(connectedMonitors)
      .where(eq(connectedMonitors.assetId, assetId));
    if (posted.length === 0) return;
    await tx.insert(connectedMonitors).values(
      posted.map((m) => ({
        assetId,
        vendorCode: m.vendor_code ?? null,
        manufacturer: vendorName(m.vendor_code),
        model: m.model ?? null,
        serial: m.serial ?? null,
        productCode: m.product_code ?? null,
        year: m.year ?? null,
        active: m.active ?? true,
        diagonalIn: m.diagonal_in ?? null,
        resolution: m.resolution ?? null,
        refreshHz: m.refresh_hz ?? null,
        seenAt,
      })),
    );
  });
}

export type ConnectedMonitorItem = {
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  year: number | null;
  active: boolean;
  diagonalIn: number | null;
  resolution: string | null;
  refreshHz: number | null;
  // Serial reconciliation (phase 3): if this display's serial matches a Monitor
  // asset in inventory, its tag + name; null when the serial is unknown to OPUS.
  matchedAssetTag: string | null;
  matchedAssetName: string | null;
};

/**
 * The displays connected to a computer (by its human tag), for the detail card.
 * Each display's serial is reconciled against Monitor assets (phase 3): a
 * case-insensitive serial match links the display to its tracked asset, so the
 * card can both cross-link and flag a display OPUS doesn't have on record. The
 * match is a left join, so a display with no serial or no matching asset simply
 * comes back unmatched. (A Monitor asset serial is unique in practice; if two
 * ever collide the first by tag wins — see the DISTINCT ON below.)
 */
export async function getConnectedMonitors(
  tag: string,
): Promise<ConnectedMonitorItem[]> {
  const monitorAsset = alias(assets, "monitor_asset");
  const rows = await db
    .selectDistinctOn([connectedMonitors.id], {
      id: connectedMonitors.id,
      manufacturer: connectedMonitors.manufacturer,
      model: connectedMonitors.model,
      serial: connectedMonitors.serial,
      year: connectedMonitors.year,
      active: connectedMonitors.active,
      diagonalIn: connectedMonitors.diagonalIn,
      resolution: connectedMonitors.resolution,
      refreshHz: connectedMonitors.refreshHz,
      matchedAssetTag: monitorAsset.tag,
      matchedAssetName: monitorAsset.name,
    })
    .from(connectedMonitors)
    .innerJoin(assets, eq(assets.id, connectedMonitors.assetId))
    .leftJoin(
      monitorAsset,
      and(
        eq(monitorAsset.type, "Monitor"),
        sql`lower(${monitorAsset.serial}) = lower(${connectedMonitors.serial})`,
      ),
    )
    .where(eq(assets.tag, tag))
    // DISTINCT ON needs the keyed column first in the sort; model/serial give the
    // card's display order within each distinct display row.
    .orderBy(
      asc(connectedMonitors.id),
      asc(monitorAsset.tag),
    );

  return rows
    .map((r) => ({
      manufacturer: r.manufacturer,
      model: r.model,
      serial: r.serial,
      year: r.year,
      active: r.active,
      diagonalIn: r.diagonalIn,
      resolution: r.resolution,
      refreshHz: r.refreshHz,
      matchedAssetTag: r.matchedAssetTag,
      matchedAssetName: r.matchedAssetName,
    }))
    // DISTINCT ON forces an id sort; restore the card's model/serial order.
    .sort(
      (a, b) =>
        (a.model ?? "").localeCompare(b.model ?? "") ||
        (a.serial ?? "").localeCompare(b.serial ?? ""),
    );
}

/** The computer a Monitor asset is currently plugged into (phase 3), resolved by
 * matching the Monitor asset's own serial against scanned connected-display
 * serials. Null when the monitor isn't a Monitor asset with a serial, or no
 * scanned computer reports that serial. Shown as "Connected to …" on the monitor
 * detail page — the reverse of the computer's Displays card. */
export type MonitorConnection = {
  computerTag: string;
  computerName: string;
  seenAt: Date;
};

export async function getMonitorConnection(
  tag: string,
): Promise<MonitorConnection | null> {
  const monitorAsset = alias(assets, "monitor_asset");
  const rows = await db
    .select({
      computerTag: assets.tag,
      computerName: assets.name,
      seenAt: connectedMonitors.seenAt,
    })
    .from(connectedMonitors)
    .innerJoin(assets, eq(assets.id, connectedMonitors.assetId))
    .innerJoin(
      monitorAsset,
      and(
        eq(monitorAsset.tag, tag),
        eq(monitorAsset.type, "Monitor"),
        sql`lower(${monitorAsset.serial}) = lower(${connectedMonitors.serial})`,
      ),
    )
    .orderBy(sql`${connectedMonitors.seenAt} desc`)
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Displays a scan has reported that aren't yet Monitor assets — the "Discovered
 * displays" list on /monitors (spec 25 follow-up). A monitor is only discoverable
 * if it reported a (non-blank) serial, since the serial is both the dedup key and
 * what a created asset is matched by. Excluded: serials that already match a
 * Monitor asset (it's in inventory) and serials an admin dismissed. One row per
 * serial (the latest scan's attributes + the computer it was last seen on); a
 * monitor moved between PCs shows its most recent host.
 */
export type DiscoveredMonitor = {
  serial: string;
  manufacturer: string | null;
  vendorCode: string | null;
  model: string | null;
  productCode: string | null;
  year: number | null;
  diagonalIn: number | null;
  resolution: string | null;
  refreshHz: number | null;
  computerTag: string;
  computerName: string;
  seenAt: Date;
};

export async function getDiscoveredMonitors(): Promise<DiscoveredMonitor[]> {
  const rows = await db
    .selectDistinctOn([sql`lower(${connectedMonitors.serial})`], {
      serial: connectedMonitors.serial,
      manufacturer: connectedMonitors.manufacturer,
      vendorCode: connectedMonitors.vendorCode,
      model: connectedMonitors.model,
      productCode: connectedMonitors.productCode,
      year: connectedMonitors.year,
      diagonalIn: connectedMonitors.diagonalIn,
      resolution: connectedMonitors.resolution,
      refreshHz: connectedMonitors.refreshHz,
      computerTag: assets.tag,
      computerName: assets.name,
      seenAt: connectedMonitors.seenAt,
    })
    .from(connectedMonitors)
    .innerJoin(assets, eq(assets.id, connectedMonitors.assetId))
    .where(
      and(
        sql`${connectedMonitors.serial} is not null`,
        sql`btrim(${connectedMonitors.serial}) <> ''`,
        // Not already a Monitor asset (matched by serial, case-insensitive).
        sql`not exists (select 1 from ${assets} ma where ma.type = 'Monitor' and lower(ma.serial) = lower(${connectedMonitors.serial}))`,
        // Not dismissed from the discovery list.
        sql`not exists (select 1 from ${dismissedMonitors} dm where dm.serial = ${connectedMonitors.serial})`,
      ),
    )
    // DISTINCT ON needs the keyed expression leftmost; newest scan wins the row.
    .orderBy(
      sql`lower(${connectedMonitors.serial}) asc`,
      sql`${connectedMonitors.seenAt} desc`,
    );

  return (rows as DiscoveredMonitor[])
    .slice()
    // Present newest-first; the DISTINCT ON forced a serial sort above.
    .sort((a, b) => b.seenAt.getTime() - a.seenAt.getTime());
}

/** Count of discoverable displays, for a badge without shipping the rows. */
export async function getDiscoveredMonitorCount(): Promise<number> {
  return (await getDiscoveredMonitors()).length;
}

/** Hide a scanned display's serial from the discovery list (idempotent). */
export async function dismissMonitor(
  serial: string,
  by: string | null,
): Promise<void> {
  const s = serial.trim();
  if (!s) return;
  await db
    .insert(dismissedMonitors)
    .values({ serial: s, dismissedBy: by })
    .onConflictDoNothing();
}

/** Bring a dismissed serial back onto the discovery list (undo a dismiss). */
export async function restoreDismissedMonitor(serial: string): Promise<void> {
  await db.delete(dismissedMonitors).where(eq(dismissedMonitors.serial, serial.trim()));
}

/**
 * Auto-create Monitor assets at ingest for the external displays a computer
 * reported (spec 25 follow-up, "auto-add external monitors only"). A scanned
 * display becomes an asset when it looks like a standalone monitor
 * (`isExternalMonitor`: has a serial, not a built-in-panel vendor), isn't already
 * a Monitor asset by serial, and hasn't been dismissed. Built-in laptop panels
 * and dismissed serials are skipped — they remain in the manual discovery list.
 *
 * The new monitor inherits the computer's location (a display is where its PC is)
 * and its assignee (whoever uses the PC uses its screens) — the assignment goes
 * through the custody engine, not a raw assigneeId write. It's created `deployed`
 * (it's plugged in and in use). Idempotent across scans:
 * once created, the serial matches a Monitor asset and is skipped. Best-effort and
 * fully isolated per display, so one failure never blocks the others or the ingest.
 * Returns the count created, for the ingest log.
 */
export async function autoCreateExternalMonitors(
  computerAssetId: string,
  posted: PostedMonitor[],
  now: Date,
): Promise<number> {
  const candidates = posted.filter((m) =>
    isExternalMonitor(m.vendor_code, m.serial),
  );
  if (candidates.length === 0) return 0;

  // The display inherits the computer's location and assignee.
  const [computer] = await db
    .select({
      locationId: assets.locationId,
      assigneeId: assets.assigneeId,
    })
    .from(assets)
    .where(eq(assets.id, computerAssetId))
    .limit(1);
  const locationId = computer?.locationId ?? null;
  const assigneeId = computer?.assigneeId ?? null;

  let created = 0;
  for (const m of candidates) {
    const serial = (m.serial ?? "").trim();
    try {
      // Skip if this serial is already a Monitor asset, or was dismissed.
      const [existingAsset] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.type, "Monitor"),
            sql`lower(${assets.serial}) = lower(${serial})`,
          ),
        )
        .limit(1);
      if (existingAsset) continue;

      const [dismissed] = await db
        .select({ serial: dismissedMonitors.serial })
        .from(dismissedMonitors)
        .where(eq(dismissedMonitors.serial, serial))
        .limit(1);
      if (dismissed) continue;

      const name = m.model || vendorName(m.vendor_code) || "Monitor";
      // Insert the asset (tag-collision retry, like the discovered-inbox create),
      // then its monitor-details row — in one transaction.
      const ok = await db.transaction(async (tx) => {
        let row: { id: string; tag: string } | undefined;
        for (let attempt = 0; attempt < 6 && !row; attempt++) {
          const inserted = await tx
            .insert(assets)
            .values({
              tag: generateTag("Monitor"),
              name,
              type: "Monitor",
              serial,
              model: m.model ?? null,
              vendor: vendorName(m.vendor_code),
              status: "deployed",
              locationId,
              lastSync: now,
            })
            .onConflictDoNothing({ target: assets.tag })
            .returning({ id: assets.id, tag: assets.tag });
          row = inserted[0];
        }
        if (!row) return false;
        await tx.insert(monitorDetails).values({
          assetId: row.id,
          sizeInches: m.diagonal_in != null ? String(m.diagonal_in) : null,
          resolution: m.resolution ?? null,
          refreshHz: m.refresh_hz ?? null,
        });
        // Inherit the computer's assignee through the custody engine (never a raw
        // assigneeId write). Best-effort: a stale/missing person won't block the
        // create — the monitor is just left Available.
        if (assigneeId) {
          await assignAssetTx(tx, row.id, assigneeId, "scan (auto)", now);
        }
        return true;
      });
      if (ok) created += 1;
    } catch (err) {
      // A unique-serial race (two concurrent ingests of the same new monitor) or
      // any other per-display failure is swallowed — never fail the ingest.
      console.error(
        `[ingest] auto-create monitor failed for serial ${serial}:`,
        err,
      );
    }
  }
  return created;
}
