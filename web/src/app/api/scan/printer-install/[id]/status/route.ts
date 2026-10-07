import { NextResponse } from "next/server";

import {
  updateInstallJobStatus,
  type InstallStatusUpdate,
} from "@/db/printer-install";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";
import type { PrinterInstallResult } from "@/db/schema";

const STATUSES = new Set(["running", "succeeded", "failed"]);

/**
 * The worker posts an install job's progress here (spec 20). Fenced by the claim:
 * a stale claim (reaped and re-run) is rejected with 409. Requires `scan:dequeue`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
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

  const { id } = await context.params;

  let body: Record<string, unknown> | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const workerId = typeof body?.workerId === "string" ? body.workerId : "";
  const claimedAt = typeof body?.claimedAt === "string" ? body.claimedAt : "";
  const status = typeof body?.status === "string" ? body.status : "";
  if (!workerId || !claimedAt || !STATUSES.has(status)) {
    return NextResponse.json(
      { error: "workerId, claimedAt and a valid status are required" },
      { status: 422 },
    );
  }

  const update: InstallStatusUpdate = {
    workerId,
    claimedAt,
    status: status as InstallStatusUpdate["status"],
    result: (body?.result as PrinterInstallResult | undefined) ?? undefined,
    error: typeof body?.error === "string" ? body.error : undefined,
  };

  const outcome = await updateInstallJobStatus(id, update);
  if (outcome === "ok") return NextResponse.json({ ok: true });
  if (outcome === "notfound") {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  return NextResponse.json(
    { error: "stale claim: this job is no longer yours" },
    { status: 409 },
  );
}
