"use server";

import { revalidatePath } from "next/cache";

import { getAssetImageRef, setAssetImageId } from "@/db/asset-images";
import { getMedia, requestCutout } from "@/db/media";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to change asset photos.",
};

/**
 * Point an asset at a library image, or clear it (spec 18, AC-2). `mediaId` null
 * removes the asset's photo (the media row and its bytes stay in the library for
 * reuse). Gated on `asset:write`, rechecked server-side. Does not touch any stored
 * object — the asset→media pointer is all that moves.
 */
export async function setAssetImage(
  tag: unknown,
  mediaId: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "asset:write")) return FORBIDDEN;

  if (typeof tag !== "string" || !tag) {
    return { ok: false, error: "Unknown asset." };
  }
  if (mediaId !== null && typeof mediaId !== "string") {
    return { ok: false, error: "Invalid image selection." };
  }

  const ref = await getAssetImageRef(tag);
  if (!ref) return { ok: false, error: "That asset no longer exists." };

  if (mediaId) {
    const media = await getMedia(mediaId);
    if (!media) return { ok: false, error: "That image is no longer in the library." };
  }

  await setAssetImageId(ref.id, mediaId ?? null);

  revalidatePath(`/assets/${tag}`);
  // The library's "used by N" is computed from assignments, so assigning or
  // clearing a photo changes it — revalidate /media or it shows a stale count.
  revalidatePath("/media");
  return {
    ok: true,
    message: mediaId ? "Photo updated." : "Photo removed.",
  };
}

const CUTOUT_FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to edit library images.",
};

/**
 * Request (or retry) background removal for a library image (spec 18 phase 3,
 * AC-9). Enqueues a cut-out job the rembg worker will pick up. Gated on
 * `asset:write`, rechecked server-side.
 */
export async function requestCutoutAction(mediaId: unknown): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "asset:write")) return CUTOUT_FORBIDDEN;
  if (typeof mediaId !== "string" || !mediaId)
    return { ok: false, error: "Unknown image." };

  const res = await requestCutout(mediaId);
  if (!res.ok) {
    if (res.error === "not-found")
      return { ok: false, error: "That image is no longer in the library." };
    return { ok: false, error: "Background removal is already running for this image." };
  }

  revalidatePath(`/media/${mediaId}`);
  return { ok: true, message: "Background removal queued." };
}
