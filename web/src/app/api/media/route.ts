import { NextResponse } from "next/server";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { createOrReuseMedia, listMedia } from "@/db/media";
import {
  isAllowedImageType,
  isStorageConfigured,
  MAX_IMAGE_BYTES,
} from "@/lib/storage";

// node:crypto + the AWS SDK need the Node.js runtime, not edge.
export const runtime = "nodejs";

/**
 * The media library collection (spec 18):
 *  - GET lists every image with its usage count, to any `asset:read` user (AC-5).
 *  - POST uploads a new image into the library (`asset:write`, type + size
 *    validated), deduped by content hash (AC-2, AC-3, AC-4). Assigning it to an
 *    asset is a separate step (the `setAssetImage` server action).
 */

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:read"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const type = parseType(url.searchParams.get("type"));
  const sort = url.searchParams.get("sort") === "most-used" ? "most-used" : "recent";
  const offset = Number(url.searchParams.get("offset")) || 0;

  const page = await listMedia({ q, type, sort, offset });
  return NextResponse.json({
    items: page.items.map((m) => ({
      id: m.id,
      name: m.name,
      altText: m.altText,
      notes: m.notes,
      contentType: m.contentType,
      sizeBytes: m.sizeBytes,
      width: m.width,
      height: m.height,
      usedBy: m.usedBy,
      createdAt: m.createdAt,
      // Bytes always flow through the authenticated app route, never a public URL.
      thumbUrl: `/api/media/${m.id}?variant=thumb`,
      originalUrl: `/api/media/${m.id}?variant=original`,
    })),
    nextOffset: page.nextOffset,
  });
}

const ASSET_TYPES = ["Computer", "Monitor", "Printer", "Phone", "Network"] as const;
type AssetTypeValue = (typeof ASSET_TYPES)[number];

/** Validate the type filter against the known asset types; anything else = no filter. */
function parseType(raw: string | null): AssetTypeValue | undefined {
  return ASSET_TYPES.includes(raw as AssetTypeValue)
    ? (raw as AssetTypeValue)
    : undefined;
}

/** Default a library name from the uploaded filename, else a generic title. */
function nameFromFile(file: File, provided: string | null): string {
  const given = provided?.trim();
  if (given) return given;
  const base = file.name?.replace(/\.[^.]+$/, "").trim();
  return base || "Untitled image";
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:write"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!isStorageConfigured())
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "no file uploaded" }, { status: 400 });

  if (!isAllowedImageType(file.type))
    return NextResponse.json(
      { error: "unsupported file type (PNG, JPEG, or WebP only)" },
      { status: 415 },
    );
  if (file.size > MAX_IMAGE_BYTES)
    return NextResponse.json({ error: "image is larger than 5 MB" }, { status: 413 });

  const bytes = Buffer.from(await file.arrayBuffer());
  // Guard again on the real byte length, in case a client lied about file.size.
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    return NextResponse.json({ error: "image is larger than 5 MB" }, { status: 413 });

  const name = form.get("name");
  const row = await createOrReuseMedia({
    bytes,
    contentType: file.type,
    name: nameFromFile(file, typeof name === "string" ? name : null),
    createdBy: user.email,
  });

  return NextResponse.json({
    ok: true,
    media: {
      id: row.id,
      name: row.name,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
    },
  });
}
