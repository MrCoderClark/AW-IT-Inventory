import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { assets, media } from "@/db/schema";
import type { MediaRow } from "@/db/schema";

/**
 * The single writer of `assets.imageId` (spec 18, superseding spec 17.02's
 * `imageKey`). Points an asset at a shared `media` library row, or clears it. The
 * media row owns the stored bytes and its own lifecycle (`src/db/media.ts`); these
 * helpers only move the asset→media pointer. Looked up by the human tag (the URL
 * key), never the internal id.
 */

export type AssetImageRef = { id: string; imageId: string | null };

/** The asset's internal id and current media id, or null when no such tag. */
export async function getAssetImageRef(
  tag: string,
): Promise<AssetImageRef | null> {
  const [row] = await db
    .select({ id: assets.id, imageId: assets.imageId })
    .from(assets)
    .where(eq(assets.tag, tag))
    .limit(1);
  return row ?? null;
}

/** The media row an asset currently points at (joined by tag), or null when the
   asset has no image or no such tag. Used to serve the asset's image variant. */
export async function getAssetMedia(
  tag: string,
): Promise<{ assetId: string; media: MediaRow | null } | null> {
  const [row] = await db
    .select({ assetId: assets.id, imageId: assets.imageId, media })
    .from(assets)
    .leftJoin(media, eq(media.id, assets.imageId))
    .where(eq(assets.tag, tag))
    .limit(1);
  if (!row) return null;
  return { assetId: row.assetId, media: row.imageId ? row.media : null };
}

/** Point the asset at a media row (or clear it with null). */
export async function setAssetImageId(
  assetId: string,
  mediaId: string | null,
): Promise<void> {
  await db
    .update(assets)
    .set({ imageId: mediaId, updatedAt: new Date() })
    .where(eq(assets.id, assetId));
}
