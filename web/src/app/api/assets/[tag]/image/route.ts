import { NextResponse } from "next/server";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { getAssetMedia } from "@/db/asset-images";
import { parseVariant, serveMediaVariant } from "@/lib/media-serve";

// node:crypto + the AWS SDK need the Node.js runtime, not edge.
export const runtime = "nodejs";

type Context = { params: Promise<{ tag: string }> };

/**
 * Serve an asset's product photo (spec 18, superseding spec 17.02). Resolves the
 * asset to its shared `media` row and streams the requested variant to any
 * `asset:read` user; the bucket stays private, so this cookie-gated route is the
 * only way the bytes reach a browser (AC-7).
 *
 * Uploading and clearing an asset's photo no longer live here: an image is added to
 * the library via `POST /api/media`, then assigned with the `setAssetImage` server
 * action (spec 18). This keeps the stable `<img src>` the table and detail pages
 * already use, now backed by media.
 */
export async function GET(req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:read"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { tag } = await context.params;
  const ref = await getAssetMedia(tag);
  if (!ref || !ref.media)
    return NextResponse.json({ error: "no image" }, { status: 404 });

  // When the image's cut-out is toggled on for display (spec 18 phase 3), serve
  // the transparent cut-out for asset surfaces; otherwise the requested variant.
  const requested = parseVariant(new URL(req.url).searchParams.get("variant"));
  const variant =
    ref.media.preferCutout && ref.media.cutoutKey ? "cutout" : requested;
  return serveMediaVariant(ref.media, variant);
}
