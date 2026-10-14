import { NextResponse } from "next/server";

import { deliverDueReports } from "@/db/report-delivery";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

// exceljs (for an .xlsx attachment) needs Node APIs.
export const runtime = "nodejs";

/**
 * The worker's periodic trigger calls this to deliver any scheduled reports that
 * are now due (spec 26 phase 2, slice 2c fires it). Web finds the due schedules,
 * runs each report, and emails it via aw-auth. Service `scan:dequeue`, the same
 * token path as the other /api/scan/* routes. No inputs; due-ness is computed
 * server-side from each schedule's nextRunAt.
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

  const result = await deliverDueReports();
  return NextResponse.json({ ok: true, ...result });
}
