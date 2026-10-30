import "server-only";

import { eq } from "drizzle-orm";

import { db } from "./index";
import { assets, connectedSignaturePads } from "./schema";

/** One signature pad as the collector posts it (snake_case). */
export type PostedSignaturePad = {
  name?: string | null;
  version?: string | null;
  connected?: boolean | null;
  com_registered?: boolean | null;
  com_bitness?: string | null;
  device_status?: string | null;
  install_location?: string | null;
};

/**
 * Replace a Computer's signature-pad set with this scan's readings.
 * Full replace in a transaction (like connected_monitors).
 */
export async function replaceConnectedSignaturePads(
  assetId: string,
  posted: PostedSignaturePad[],
  seenAt: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(connectedSignaturePads)
      .where(eq(connectedSignaturePads.assetId, assetId));
    if (posted.length === 0) return;
    await tx.insert(connectedSignaturePads).values(
      posted.map((p) => ({
        assetId,
        name: p.name ?? null,
        version: p.version ?? null,
        connected: p.connected ?? false,
        comRegistered: p.com_registered ?? false,
        comBitness: p.com_bitness ?? null,
        deviceStatus: p.device_status ?? null,
        installLocation: p.install_location ?? null,
        seenAt,
      })),
    );
  });
}

/** UI-facing shape returned by the read helper. */
export type SignaturePadItem = {
  name: string | null;
  version: string | null;
  connected: boolean;
  comRegistered: boolean;
  comBitness: string | null;
  deviceStatus: string | null;
  installLocation: string | null;
};

/** Read all signature pads for a computer identified by its asset tag. */
export async function getConnectedSignaturePads(
  tag: string,
): Promise<SignaturePadItem[]> {
  const rows = await db
    .select({
      name: connectedSignaturePads.name,
      version: connectedSignaturePads.version,
      connected: connectedSignaturePads.connected,
      comRegistered: connectedSignaturePads.comRegistered,
      comBitness: connectedSignaturePads.comBitness,
      deviceStatus: connectedSignaturePads.deviceStatus,
      installLocation: connectedSignaturePads.installLocation,
    })
    .from(connectedSignaturePads)
    .innerJoin(assets, eq(assets.id, connectedSignaturePads.assetId))
    .where(eq(assets.tag, tag));

  return rows;
}
