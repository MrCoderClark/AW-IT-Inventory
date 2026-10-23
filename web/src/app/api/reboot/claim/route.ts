import { NextResponse } from "next/server";

import { claimNextReboot } from "@/db/reboot";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

/**
 * Collector claims one due scheduled reboot job (spec 31 v2).
 * Service `deploy:agent`. 204 when the queue is empty.
 */
export async function POST(request: Request) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const identity = await verifyServiceToken(token, "deploy:agent");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing deploy:agent scope" },
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

  const job = await claimNextReboot(workerId);
  if (!job) return new NextResponse(null, { status: 204 });
  return NextResponse.json(job);
}
