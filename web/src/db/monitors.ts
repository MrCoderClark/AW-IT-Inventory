import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "./index";
import { assets, connectedMonitors } from "./schema";
import { vendorName } from "@/lib/pnp-vendors";

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
