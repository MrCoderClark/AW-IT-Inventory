import { NextResponse } from "next/server";

import { sweepWarrantyNotifications } from "@/db/notifications";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The worker's daily warranty sweep (spec 19, AC-5). Creates an in-app
 * notification for every asset whose warranty is expired or expiring within the
 * threshold (default 30 days; the worker may pass `withinDays`). Idempotent per
 * asset+warranty-date, so running it daily never spams. Service `scan:dequeue`,
 * the same token path as the other `/api/scan/*` worker endpoints.
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

  let body: { withinDays?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const withinDays =
    typeof body?.withinDays === "number" && body.withinDays >= 0
      ? body.withinDays
      : undefined;

  const created = await sweepWarrantyNotifications({ withinDays });
  return NextResponse.json({ ok: true, created });
}
