import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import {
  clearAssetImageKey,
  getAssetImageRef,
  setAssetImageKey,
} from "@/db/asset-images";
import {
  getImageBytes,
  isAllowedImageType,
  isStorageConfigured,
  MAX_IMAGE_BYTES,
  newImageKey,
  putImage,
  removeImage,
} from "@/lib/storage";

// node:crypto + the AWS SDK need the Node.js runtime, not edge.
export const runtime = "nodejs";

type Context = { params: Promise<{ tag: string }> };

/**
 * Asset product image (spec 17.02). One authenticated route, three methods:
 *  - GET streams the private object to any `asset:read` user (AC-2.2, AC-2.5).
 *  - POST uploads/replaces it (`asset:write`, type + size validated) (AC-2.1, 2.3, 2.4).
 *  - DELETE removes it (`asset:write`) (AC-2.4).
 * The bucket is never public; bytes only reach a browser through this cookie-gated
 * route.
 */

export async function GET(_req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:read"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { tag } = await context.params;
  const ref = await getAssetImageRef(tag);
  if (!ref || !ref.imageKey)
    return NextResponse.json({ error: "no image" }, { status: 404 });

  if (!isStorageConfigured())
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });

  const obj = await getImageBytes(ref.imageKey);
  if (!obj) return NextResponse.json({ error: "no image" }, { status: 404 });

  return new NextResponse(Buffer.from(obj.bytes), {
    headers: {
      "Content-Type": obj.contentType,
      // Private: the bytes are behind an asset:read cookie, so a shared proxy
      // must never serve one session's image to another (spec 17.02 invariant).
      "Cache-Control": "private, max-age=300",
    },
  });
}

export async function POST(req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:write"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!isStorageConfigured())
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });

  const { tag } = await context.params;
  const ref = await getAssetImageRef(tag);
  if (!ref) return NextResponse.json({ error: "no such asset" }, { status: 404 });

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
    return NextResponse.json(
      { error: "image is larger than 5 MB" },
      { status: 413 },
    );

  const bytes = Buffer.from(await file.arrayBuffer());
  // Guard again on the real byte length, in case a client lied about file.size.
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    return NextResponse.json(
      { error: "image is larger than 5 MB" },
      { status: 413 },
    );

  const key = newImageKey(ref.id, file.type);
  await putImage(key, bytes, file.type);

  // Only after the new object is safely stored do we repoint the row and drop
  // the old object, so a failed upload never orphans the row or the bytes.
  const previous = ref.imageKey;
  await setAssetImageKey(ref.id, key);
  if (previous && previous !== key) await removeImage(previous);

  revalidatePath(`/assets/${tag}`);
  return NextResponse.json({ ok: true, imageKey: key });
}

export async function DELETE(_req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:write"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { tag } = await context.params;
  const ref = await getAssetImageRef(tag);
  if (!ref) return NextResponse.json({ error: "no such asset" }, { status: 404 });

  if (ref.imageKey) {
    await clearAssetImageKey(ref.id);
    if (isStorageConfigured()) await removeImage(ref.imageKey);
  }

  revalidatePath(`/assets/${tag}`);
  return NextResponse.json({ ok: true });
}
