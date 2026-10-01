import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { deleteMedia, getMedia, updateMediaMeta } from "@/db/media";
import { parseVariant, serveMediaVariant } from "@/lib/media-serve";

// node:crypto + the AWS SDK need the Node.js runtime, not edge.
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * A single media-library image (spec 18):
 *  - GET streams a variant (thumb|original|cutout) to any `asset:read` user (AC-7).
 *  - PATCH edits its metadata — name, alt text, notes (`asset:write`) (AC-5).
 *  - DELETE removes it, blocked while any asset uses it (`asset:write`) (AC-6).
 */

export async function GET(req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:read"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await context.params;
  const row = await getMedia(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const variant = parseVariant(new URL(req.url).searchParams.get("variant"));
  return serveMediaVariant(row, variant);
}

export async function PATCH(req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:write"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await context.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object")
    return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { name, altText, notes } = body as {
    name?: unknown;
    altText?: unknown;
    notes?: unknown;
  };
  if (name !== undefined && (typeof name !== "string" || !name.trim()))
    return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });

  const res = await updateMediaMeta(id, {
    name: typeof name === "string" ? name.trim() : undefined,
    altText: altText === undefined ? undefined : normalizeOptional(altText),
    notes: notes === undefined ? undefined : normalizeOptional(notes),
  });
  if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 });

  revalidatePath("/media");
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "asset:write"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await context.params;
  const res = await deleteMedia(id);
  if (!res.ok) {
    if (res.error === "not-found")
      return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(
      { error: "in use", usedBy: res.usedBy },
      { status: 409 },
    );
  }

  revalidatePath("/media");
  return NextResponse.json({ ok: true });
}

/** Trim a string field; an empty string clears it to null. */
function normalizeOptional(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}
