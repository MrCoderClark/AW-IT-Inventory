import { NextResponse } from "next/server";

import { getDiscoverySettings } from "@/db/discovery";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The collector reads the discovery type toggles here before each automatic
 * sweep (spec 13, AC-3). Returns `{ computer, printer }`, coalescing an absent
 * row to `true` (AC-2). Same service-token posture as the other /api/scan/*
 * routes: a service account carrying `scan:dequeue` (AC-7).
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

  const settings = await getDiscoverySettings();
  return NextResponse.json(settings);
}
