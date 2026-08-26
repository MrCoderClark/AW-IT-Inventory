import { NextResponse } from "next/server";

import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";
import { ingestScan, type IngestPayload } from "@/db/ingest";

export async function POST(request: Request) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token) {
    return NextResponse.json(
      { error: "missing bearer token" },
      { status: 401 },
    );
  }

  const identity = await verifyServiceToken(token, "ingest:write");
  if (!identity) {
    return NextResponse.json(
      { error: "invalid token or missing ingest:write scope" },
      { status: 403 },
    );
  }

  let body: IngestPayload | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.hosts)) {
    return NextResponse.json(
      { error: "expected JSON body with a hosts array" },
      { status: 400 },
    );
  }

  const result = await ingestScan(body);
  return NextResponse.json({ ok: true, run_id: body.run_id ?? null, ...result });
}
