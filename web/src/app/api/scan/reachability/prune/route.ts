import { NextResponse } from "next/server";

import { pruneCounters } from "@/db/counters";
import { pruneNotifications } from "@/db/notifications";
import { pruneChecks } from "@/db/reachability";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The worker's daily retention task calls this to prune old history older than
 * its configured window: reachability checks (spec 12, AC-10) and printer page-
 * counter snapshots (spec 14, AC-6). The worker owns the retention default (365
 * days) and passes it as `retentionDays`. Service `scan:dequeue`.
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

  // Notifications keep their own shorter retention (spec 19, AC-10) rather than
  // the long checks/counters window, so prune with the module default.
  const [pruned, prunedCounters, prunedNotifications] = await Promise.all([
    pruneChecks(retentionDays),
    pruneCounters(retentionDays),
    pruneNotifications(),
  ]);
  return NextResponse.json({
    ok: true,
    pruned,
    prunedCounters,
    prunedNotifications,
  });
}
