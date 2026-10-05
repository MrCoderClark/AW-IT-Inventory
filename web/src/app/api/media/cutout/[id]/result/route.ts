import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { completeCutout } from "@/db/media";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";
import { isStorageConfigured } from "@/lib/storage";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * The rembg worker posts a cut-out job's result here (spec 18 phase 3): on success,
 * the background-removed PNG (base64); on failure, `status: "failed"`. Fenced by the
 * claim — a result from a worker that no longer owns the job is dropped. Service
 * `scan:dequeue` only.
 */
export async function POST(request: Request, context: Context) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const identity = await verifyServiceToken(token, "scan:dequeue");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing scan:dequeue scope" },
      { status: 403 },
    );

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const workerId =
    typeof body?.workerId === "string" ? body.workerId.trim() : "";
  if (!workerId)
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });

  const ok = body?.status === "done";
  if (ok) {
    if (!isStorageConfigured())
      return NextResponse.json({ error: "storage not configured" }, { status: 503 });
    const b64 = typeof body?.cutoutB64 === "string" ? body.cutoutB64 : "";
    if (!b64)
      return NextResponse.json({ error: "cutoutB64 is required" }, { status: 400 });
    const bytes = Buffer.from(b64, "base64");
    const res = await completeCutout(id, workerId, { ok: true, cutoutBytes: bytes });
    if (!res.ok)
      return NextResponse.json({ error: "claim lost" }, { status: 409 });
  } else {
    const res = await completeCutout(id, workerId, { ok: false });
    if (!res.ok)
      return NextResponse.json({ error: "claim lost" }, { status: 409 });
  }

  revalidatePath(`/media/${id}`);
  revalidatePath("/media");
  return NextResponse.json({ ok: true });
}
