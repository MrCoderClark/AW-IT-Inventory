import { NextResponse } from "next/server";

import { recordChecks, markAlertSent, type IncomingCheck } from "@/db/reachability";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";
import { sendPrinterAlert } from "@/lib/notify";

/**
 * The worker posts printer reachability checks here (spec 12, AC-6, AC-7). Each
 * check writes its history row and updates the printer's rollup in one
 * transaction; any up/down transition then fires one admin email via aw-auth,
 * and `lastAlertState` is advanced only once the send succeeds so a failed send
 * is retried by the next check and never double-fires. Service `scan:dequeue`.
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

  let body: { checks?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.checks)) {
    return NextResponse.json(
      { error: "expected JSON body with a checks array" },
      { status: 422 },
    );
  }

  // Validate each check; a malformed entry is dropped rather than failing the batch.
  const checks: IncomingCheck[] = [];
  for (const raw of body.checks) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.assetId !== "string" || typeof c.reachable !== "boolean") continue;
    if (c.method !== "tcp" && c.method !== "snmp") continue;
    if (c.source !== "scheduled" && c.source !== "manual") continue;
    checks.push({
      assetId: c.assetId,
      reachable: c.reachable,
      latencyMs: typeof c.latencyMs === "number" ? c.latencyMs : null,
      method: c.method,
      source: c.source,
      checkedAt: typeof c.checkedAt === "string" ? c.checkedAt : null,
    });
  }

  const events = await recordChecks(checks);

  // Fire the transition emails after the writes committed. Best-effort: a failed
  // send is logged inside sendPrinterAlert and left pending for the next check.
  let alertsFired = 0;
  for (const event of events) {
    const sent = await sendPrinterAlert(event);
    if (sent) {
      await markAlertSent(event.assetId, event.event);
      alertsFired += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    recorded: checks.length,
    transitions: events.length,
    alertsFired,
  });
}
