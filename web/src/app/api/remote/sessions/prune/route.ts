import { NextResponse } from "next/server";

import { pruneRemoteSessionEvents } from "@/db/remote-sessions";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

/**
 * The worker's daily retention task calls this to prune remote-session event rows
 * (the terminal transcript / audit log, spec 24 AC-7) older than its configured
 * window. The worker owns the retention default and passes it as `retentionDays`.
 * Service token with `remote:agent` (the collector already carries it for the relay).
 */
export async function POST(request: Request) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const identity = await verifyServiceToken(token, "remote:agent");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing remote:agent scope" },
      { status: 403 },
    );

  let body: { retentionDays?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const retentionDays =
    typeof body?.retentionDays === "number" && body.retentionDays > 0
      ? body.retentionDays
      : 30;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const pruned = await pruneRemoteSessionEvents(cutoff);
  return NextResponse.json({ ok: true, pruned });
}
