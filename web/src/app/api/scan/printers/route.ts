import { NextResponse } from "next/server";

import { listPrinterTargets } from "@/db/reachability";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The collector worker polls this before each reachability sweep to learn which
 * printers to probe (spec 12, AC-6): every manually-entered printer's asset id
 * and current IP. Service `scan:dequeue` only, same token path as the other
 * /api/scan/* routes. Read-only.
 */
export async function GET(request: Request) {
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

  const printers = await listPrinterTargets();
  return NextResponse.json({ printers });
}
