import "server-only";

import { NextResponse } from "next/server";

import type { MediaRow } from "@/db/schema";
import { getImageBytes, isStorageConfigured } from "@/lib/storage";

/**
 * Serve a media row's image bytes through the authenticated app route (spec 18,
 * AC-7): the bucket stays private, so this is the only way bytes reach a browser.
 * Shared by `GET /api/media/[id]` and `GET /api/assets/[tag]/image`.
 *
 * Variant fallback: `thumb` falls back to the original when no thumbnail exists yet
 * (legacy rows, or before phase 2's backfill); `original` is always present;
 * `cutout` returns 404 until phase 3 fills `cutoutKey` (not a column yet).
 */
export type MediaVariant = "thumb" | "original" | "cutout";

export function parseVariant(raw: string | null): MediaVariant {
  return raw === "thumb" || raw === "cutout" ? raw : "original";
}

export async function serveMediaVariant(
  row: MediaRow,
  variant: MediaVariant,
): Promise<NextResponse> {
  if (!isStorageConfigured())
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });

  // Resolve the variant to a concrete object key, applying the fallback rules.
  let key: string | null;
  if (variant === "cutout") {
    key = row.cutoutKey ?? null; // 404 until a cut-out has been produced (phase 3)
  } else if (variant === "thumb") {
    key = row.thumbnailKey ?? row.objectKey;
  } else {
    key = row.objectKey;
  }
  if (!key) return NextResponse.json({ error: "no such variant" }, { status: 404 });

  const obj = await getImageBytes(key);
  if (!obj) return NextResponse.json({ error: "no image" }, { status: 404 });

  return new NextResponse(Buffer.from(obj.bytes), {
    headers: {
      "Content-Type": obj.contentType,
      // Private: bytes sit behind an asset:read cookie, so a shared proxy must
      // never serve one session's image to another. The object is immutable
      // (content-addressed), so it can be cached hard by the private client cache.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
