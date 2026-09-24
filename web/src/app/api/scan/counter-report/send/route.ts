import { NextResponse } from "next/server";

import { sendCounterReport } from "@/lib/counter-report";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The worker's daily job calls this to send the printer page-counter report
 * (spec 14, AC-4). It assembles the per-printer rows and asks aw-auth to email
 * the admins. Service `scan:dequeue`, the same token path as the other
 * /api/scan/* routes (AC-7). No inputs; the report is always today's.
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

  const { sent, printers } = await sendCounterReport();
  return NextResponse.json({ ok: true, printers, sent });
}
