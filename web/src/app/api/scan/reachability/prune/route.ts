import { NextResponse } from "next/server";

import { pruneChecks } from "@/db/reachability";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The worker's daily retention task calls this to prune reachability history
 * older than its configured window (spec 12, AC-10). The worker owns the
 * retention default (365 days) and passes it as `retentionDays`. Service
 * `scan:dequeue`.
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

  let body: { retentionDays?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const retentionDays =
    typeof body?.retentionDays === "number" ? body.retentionDays : 365;

  const pruned = await pruneChecks(retentionDays);
  return NextResponse.json({ ok: true, pruned });
}
