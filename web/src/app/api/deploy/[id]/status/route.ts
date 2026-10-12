import { NextResponse } from "next/server";

import {
  updateDeploymentStatus,
  type DeployStatusUpdate,
} from "@/db/software-deploy";
import type { SoftwareDeployResult } from "@/db/schema";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * The collector worker reports a deployment's status (spec 23, AC-6), fenced by the
 * claim (`workerId` + `claimedAt`) → 409 on a stale claim. `running` on start;
 * `succeeded`/`failed` with the per-step result at the end. Service `deploy:agent`.
 */
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
    result?: unknown;
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
    body?.status === "running" || body?.status === "succeeded" || body?.status === "failed"
      ? body.status
      : null;
  if (!workerId || !claimedAt)
    return NextResponse.json(
      { error: "workerId and claimedAt are required" },
      { status: 400 },
    );
  if (!status)
    return NextResponse.json({ error: "invalid status" }, { status: 400 });

  const update: DeployStatusUpdate = { workerId, claimedAt, status };
  if (typeof body?.error === "string") update.error = body.error.slice(0, 2000);
  if (body?.result && typeof body.result === "object")
    update.result = body.result as SoftwareDeployResult;

  const { id } = await context.params;
  const outcome = await updateDeploymentStatus(id, update);
  if (outcome === "notfound")
    return NextResponse.json({ error: "no such deployment" }, { status: 404 });
  if (outcome === "stale")
    return NextResponse.json({ error: "stale claim" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
