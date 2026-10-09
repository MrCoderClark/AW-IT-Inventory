import "server-only";

import { eq } from "drizzle-orm";

import { db } from "./index";
import { trackedSoftware } from "./schema";
import { processIcon } from "@/lib/image";
import { getImageBytes, putImage, removeImage } from "@/lib/storage";

/**
 * Admin-managed software icons (spec 22). Each tracked title may carry one small
 * PNG, stored under `software-icons/{trackedId}.png` in the same private bucket as
 * asset/media images and served through the authenticated icon route. The upload
 * is normalized to a 128px PNG by `processIcon` (sharp), so the serve route can
 * always assume `image/png`. Managing icons is gated on `scan:write`, rechecked in
 * the route; this module is the single writer of `tracked_software.iconKey`.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable object key for a title's icon (the id is already random). */
function iconKeyFor(trackedId: string): string {
  return `software-icons/${trackedId}.png`;
}

export type SetSoftwareIconResult = "ok" | "not-found" | "bad-image";

/** Store (or replace) a tracked title's icon from the uploaded bytes. */
export async function setSoftwareIcon(
  trackedId: string,
  bytes: Buffer,
): Promise<SetSoftwareIconResult> {
  if (!UUID_RE.test(trackedId)) return "not-found";

  const [row] = await db
    .select({ id: trackedSoftware.id })
    .from(trackedSoftware)
    .where(eq(trackedSoftware.id, trackedId))
    .limit(1);
  if (!row) return "not-found";

  let png: Buffer;
  try {
    png = await processIcon(bytes);
  } catch {
    return "bad-image";
  }

  const key = iconKeyFor(trackedId);
  await putImage(key, png, "image/png");
  const now = new Date();
  await db
    .update(trackedSoftware)
    .set({ iconKey: key, iconUpdatedAt: now, updatedAt: now })
    .where(eq(trackedSoftware.id, trackedId));
  return "ok";
}

/** Remove a tracked title's custom icon (its object and the row columns). */
export async function removeSoftwareIcon(trackedId: string): Promise<boolean> {
  if (!UUID_RE.test(trackedId)) return false;

  const [row] = await db
    .select({ iconKey: trackedSoftware.iconKey })
    .from(trackedSoftware)
    .where(eq(trackedSoftware.id, trackedId))
    .limit(1);
  if (!row) return false;

  if (row.iconKey) await removeImage(row.iconKey);
  const now = new Date();
  await db
    .update(trackedSoftware)
    .set({ iconKey: null, iconUpdatedAt: null, updatedAt: now })
    .where(eq(trackedSoftware.id, trackedId));
  return true;
}

/** The stored icon bytes for the serve route, or null when there is no custom icon. */
export async function getSoftwareIconObject(
  trackedId: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!UUID_RE.test(trackedId)) return null;

  const [row] = await db
    .select({ iconKey: trackedSoftware.iconKey })
    .from(trackedSoftware)
    .where(eq(trackedSoftware.id, trackedId))
    .limit(1);
  if (!row?.iconKey) return null;

  return getImageBytes(row.iconKey);
}
