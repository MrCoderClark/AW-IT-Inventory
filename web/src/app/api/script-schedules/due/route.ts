import { NextResponse } from "next/server";

import { materializeDueScriptSchedules } from "@/db/script-schedules";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

/**
 * Worker tick for scheduled script runs (spec 32 v2). Web finds due schedules,
 * materializes each into a batch, and advances nextRunAt. Service `deploy:agent`.
 */
export async function POST(request: Request) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  const identity = await verifyServiceToken(token, "deploy:agent");
  if (!identity) {
    return NextResponse.json(
      { error: "invalid token or missing deploy:agent scope" },
      { status: 403 },
    );
  }

  const result = await materializeDueScriptSchedules();
  return NextResponse.json({ ok: true, ...result });
}
