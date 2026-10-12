import { NextResponse } from "next/server";

import { claimNextDeployment } from "@/db/software-deploy";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

/**
 * The collector worker polls this to claim one pending deployment (spec 23, AC-3).
 * Returns the claimed job (id, assetTag, targetIp, frozen packageSnapshot, claim
 * fence) or 204 when none is waiting. Requires the dedicated `deploy:agent` scope.
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

  const job = await claimNextDeployment(workerId);
  if (!job) return new NextResponse(null, { status: 204 });
  return NextResponse.json(job);
}
