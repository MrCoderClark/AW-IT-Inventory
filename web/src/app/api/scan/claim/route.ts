import { NextResponse } from "next/server";

import { claimNextJob } from "@/db/scan";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The collector worker polls this to claim exactly one pending scan job (spec
 * 12, AC-3). Also records the worker heartbeat and reaps stale claims. Returns
 * the claimed job, or 204 when the queue is empty.
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

  let body: { workerId?: unknown; version?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const workerId = typeof body?.workerId === "string" ? body.workerId.trim() : "";
  if (!workerId) {
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });
  }
  const version = typeof body?.version === "string" ? body.version : null;

  const job = await claimNextJob(workerId, version);
  if (!job) return new NextResponse(null, { status: 204 });
  return NextResponse.json(job);
}
