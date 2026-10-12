import { NextResponse } from "next/server";

import { claimNextRemoteSession } from "@/db/remote-sessions";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

/**
 * The collector worker polls this to claim one pending remote session (spec 24,
 * AC-3). Returns the claimed session (id, target, claim fence) or 204 when none is
 * waiting. Requires a service token carrying the dedicated `remote:agent` scope —
 * least-privilege-separated from scanning (`scan:dequeue`).
 */
export async function POST(request: Request) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const identity = await verifyServiceToken(token, "remote:agent");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing remote:agent scope" },
      { status: 403 },
    );

  let body: { workerId?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const workerId = typeof body?.workerId === "string" ? body.workerId.trim() : "";
  if (!workerId)
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });

  const session = await claimNextRemoteSession(workerId);
  if (!session) return new NextResponse(null, { status: 204 });
  return NextResponse.json(session);
}
