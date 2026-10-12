import { NextResponse } from "next/server";

import { pruneDeployments } from "@/db/software-deploy";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

/**
 * The worker's daily retention task calls this to prune old terminal deployments
 * (spec 23). The worker owns the retention default and passes it as `retentionDays`.
 * Service token with `deploy:agent`.
 */
export async function POST(request: Request) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const identity = await verifyServiceToken(token, "deploy:agent");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing deploy:agent scope" },
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
      : 90;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const pruned = await pruneDeployments(cutoff);
  return NextResponse.json({ ok: true, pruned });
}
