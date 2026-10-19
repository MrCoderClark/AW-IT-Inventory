import { NextResponse } from "next/server";

import { updateMissingUpdateCheckStatus } from "@/db/missing-update-checks";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  const identity = await verifyServiceToken(token, "deploy:agent");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing deploy:agent scope" },
      { status: 403 },
    );

  let body: {
    workerId?: unknown;
    claimedAt?: unknown;
    status?: unknown;
    error?: unknown;
  } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const workerId = typeof body?.workerId === "string" ? body.workerId : "";
  const claimedAt = typeof body?.claimedAt === "string" ? body.claimedAt : "";
  const status =
    body?.status === "running" ||
    body?.status === "succeeded" ||
    body?.status === "failed"
      ? body.status
      : null;
  if (!workerId || !claimedAt)
    return NextResponse.json(
      { error: "workerId and claimedAt are required" },
      { status: 400 },
    );
  if (!status)
    return NextResponse.json({ error: "invalid status" }, { status: 400 });

  const { id } = await context.params;
  const outcome = await updateMissingUpdateCheckStatus(id, {
    workerId,
    claimedAt,
    status,
    error: typeof body?.error === "string" ? body.error.slice(0, 2000) : undefined,
  });
  if (outcome === "notfound")
    return NextResponse.json({ error: "no such job" }, { status: 404 });
  if (outcome === "stale")
    return NextResponse.json({ error: "stale claim" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
