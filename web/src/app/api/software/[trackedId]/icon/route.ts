import { NextResponse } from "next/server";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import {
  getSoftwareIconObject,
  removeSoftwareIcon,
  setSoftwareIcon,
} from "@/db/software-icons";
import {
  isAllowedImageType,
  isStorageConfigured,
  MAX_IMAGE_BYTES,
} from "@/lib/storage";

// sharp (icon processing) + the AWS SDK need the Node.js runtime, not edge.
export const runtime = "nodejs";

type Context = { params: Promise<{ trackedId: string }> };

/**
 * A tracked title's admin-managed brand icon (spec 22):
 *  - GET streams the stored PNG to any `asset:read` user (the bucket is private,
 *    so this cookie-gated route is the only way the bytes reach a browser). 404
 *    when the title has no custom icon — the UI then falls back to the built-in
 *    registry / generic glyph.
 *  - POST uploads/replaces the icon (`scan:write`, type + size validated, resized
 *    to a 128px PNG).
 *  - DELETE removes it (`scan:write`).
 */
export async function GET(_req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:read"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { trackedId } = await context.params;
  const obj = await getSoftwareIconObject(trackedId);
  if (!obj) return NextResponse.json({ error: "no icon" }, { status: 404 });

  return new NextResponse(Buffer.from(obj.bytes), {
    status: 200,
    headers: {
      "Content-Type": obj.contentType,
      // The src is cache-busted with ?v=<iconUpdatedAt>, so a hit is immutable.
      "Cache-Control": "private, max-age=300",
    },
  });
}

export async function POST(req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "scan:write"))
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
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    return NextResponse.json({ error: "image is larger than 5 MB" }, { status: 413 });

  const { trackedId } = await context.params;
  const result = await setSoftwareIcon(trackedId, bytes);
  if (result === "not-found")
    return NextResponse.json({ error: "unknown software title" }, { status: 404 });
  if (result === "bad-image")
    return NextResponse.json({ error: "could not read that image" }, { status: 400 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "scan:write"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { trackedId } = await context.params;
  const removed = await removeSoftwareIcon(trackedId);
  if (!removed)
    return NextResponse.json({ error: "unknown software title" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
