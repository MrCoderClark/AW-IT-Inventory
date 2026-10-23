import { NextResponse } from "next/server";

import { materializeDueRebootSchedules } from "@/db/reboot-schedules";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

/**
 * Worker tick for recurring reboot schedules (spec 31 v2). Web finds enabled
 * schedules missing an in-flight child and materializes the next job. Service
 * `deploy:agent`.
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

  const result = await materializeDueRebootSchedules();
  return NextResponse.json({ ok: true, ...result });
}
