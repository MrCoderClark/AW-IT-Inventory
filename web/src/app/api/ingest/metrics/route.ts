import { NextResponse } from "next/server";

import { evaluateMetricAlerts } from "@/db/alert-rules";
import { recordMetrics, type MetricSample } from "@/db/metrics";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

/**
 * The worker's metrics loop posts a batch of device samples here (spec 29). Each
 * sample is one CPU/RAM/disk/uptime reading for a known Computer, keyed by its
 * asset id (the worker got it from the computer-targets endpoint). Service
 * `scan:dequeue` — the same token path as the other /api/scan|ingest routes. A
 * gauge the collector couldn't read is null (a gap), never 0.
 */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

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

  let body: { samples?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.samples)) {
    return NextResponse.json(
      { error: "expected JSON body with a samples array" },
      { status: 400 },
    );
  }

  const samples: MetricSample[] = [];
  for (const raw of body.samples) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.assetId !== "string" || !s.assetId) continue;
    const sampledAt = s.sampled_at ? new Date(String(s.sampled_at)) : new Date();
    if (Number.isNaN(sampledAt.getTime())) continue;
    samples.push({
      assetId: s.assetId,
      sampledAt,
      cpuPct: num(s.cpu_pct),
      memPct: num(s.mem_pct),
      diskPct: num(s.disk_pct),
      uptimeSec: num(s.uptime_sec),
    });
  }

  let recorded = 0;
  try {
    recorded = await recordMetrics(samples);
  } catch (err) {
    // A bad asset id (e.g. a device deleted mid-cadence) must not 500 the batch.
    console.error("[ingest/metrics] insert failed:", err);
    return NextResponse.json(
      { ok: false, received: body.samples.length, recorded: 0 },
      { status: 200 },
    );
  }
  // Threshold alerts (spec 30): best-effort, never fail the ingest.
  if (samples.length > 0) {
    try {
      await evaluateMetricAlerts(samples);
    } catch (err) {
      console.error("[ingest/metrics] alert evaluate failed:", err);
    }
  }
  return NextResponse.json({ ok: true, received: body.samples.length, recorded });
}
