import { NextResponse } from "next/server";

import { claimNextInstallJob } from "@/db/printer-install";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The collector worker polls this to claim one pending printer-install job
 * (spec 20). Atomic claim + stale reaper, same as the scan claim. Returns the
 * claimed job (with the package snapshot + connection), or 204 when idle.
 */
export async function POST(request: Request) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  const identity = await verifyServiceToken(token, "scan:dequeue");
  if (!identity) {
    return NextResponse.json(
      { error: "invalid token or missing scan:dequeue scope" },
      { status: 403 },
    );
  }

  let body: { workerId?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const workerId = typeof body?.workerId === "string" ? body.workerId.trim() : "";
  if (!workerId) {
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });
  }

  const job = await claimNextInstallJob(workerId);
  if (!job) return new NextResponse(null, { status: 204 });
  return NextResponse.json(job);
}
