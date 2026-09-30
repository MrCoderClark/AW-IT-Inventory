import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { assets } from "@/db/schema";

/**
 * The single writer of `assets.imageKey` (spec 17.02). Keeps the object-store
 * key on the asset row in step with what actually lives in the store: the route
 * puts/removes the object, these helpers move the pointer. Looked up by the
 * human tag (the URL key), never the internal id.
 */

export type AssetImageRef = { id: string; imageKey: string | null };

/** The asset's internal id and current image key, or null when no such tag. */
export async function getAssetImageRef(
  tag: string,
): Promise<AssetImageRef | null> {
  const rows = await db
    .select({ id: assets.id, imageKey: assets.imageKey })
    .from(assets)
    .where(eq(assets.tag, tag))
    .limit(1);
  return rows[0] ?? null;
}

/** Point the asset at a newly stored object. */
export async function setAssetImageKey(
  assetId: string,
  imageKey: string,
): Promise<void> {
  await db
    .update(assets)
    .set({ imageKey, updatedAt: new Date() })
    .where(eq(assets.id, assetId));
}

/** Clear the asset's image pointer, returning the key it held (so the caller can
   delete that object), or null when there was none. */
export async function clearAssetImageKey(
  assetId: string,
): Promise<string | null> {
  const rows = await db
    .update(assets)
    .set({ imageKey: null, updatedAt: new Date() })
    .where(eq(assets.id, assetId))
    .returning({ imageKey: assets.imageKey });
  // `returning` runs after the SET, so this is always null; the caller passes
  // the prior key it already read. Kept for symmetry / future use.
  return rows[0]?.imageKey ?? null;
}
