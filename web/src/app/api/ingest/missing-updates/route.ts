import { NextResponse } from "next/server";

import {
  replaceMissingUpdates,
  type PostedMissingUpdate,
} from "@/db/patches";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * Worker missing-patch Search posts a batch here (spec 31 phase 2). Each result
 * is one Computer's current missing OS updates. Service `scan:dequeue` — same
 * token path as metrics. A host the collector couldn't Search is omitted (gap).
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

  let body: { results?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.results)) {
    return NextResponse.json(
      { error: "expected JSON body with a results array" },
      { status: 400 },
    );
  }

  let recorded = 0;
  for (const raw of body.results) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.assetId !== "string" || !r.assetId) continue;
    const collectedAt = r.collected_at
      ? new Date(String(r.collected_at))
      : new Date();
    if (Number.isNaN(collectedAt.getTime())) continue;
    const missingRaw = Array.isArray(r.missing) ? r.missing : [];
    const missing: PostedMissingUpdate[] = [];
    for (const m of missingRaw) {
      if (!m || typeof m !== "object") continue;
      const row = m as Record<string, unknown>;
      missing.push({
        kb: typeof row.kb === "string" ? row.kb : null,
        title: typeof row.title === "string" ? row.title : null,
        severity: typeof row.severity === "string" ? row.severity : null,
        size_bytes:
          typeof row.size_bytes === "number" && Number.isFinite(row.size_bytes)
            ? row.size_bytes
            : null,
      });
    }
    try {
      await replaceMissingUpdates(r.assetId, missing, collectedAt);
      recorded += 1;
    } catch (err) {
      console.error(
        `[ingest/missing-updates] replace failed for ${r.assetId}:`,
        err,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    received: body.results.length,
    recorded,
  });
}
