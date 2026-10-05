import { NextResponse } from "next/server";

import { listComputerScanTargets } from "@/db/queries";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The collector worker polls this before each scheduled computer sweep to learn
 * which computers to scan: every Computer asset with a manually-entered IP
 * (computer_details.ipAddress). A targeted list of known hosts, never a subnet.
 * Service `scan:dequeue` only, same token path as the other /api/scan/* routes.
 * Read-only.
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

  const computers = await listComputerScanTargets();
  return NextResponse.json({ computers });
}
