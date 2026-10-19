import { NextResponse } from "next/server";

import { prunePatchInstallJobs } from "@/db/patch-install";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

/**
 * Daily retention prune for terminal patch-install jobs (spec 31 phase 3).
 * Service `deploy:agent`.
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
  const days =
    typeof body?.retentionDays === "number" && body.retentionDays > 0
      ? Math.min(Math.trunc(body.retentionDays), 3650)
      : 30;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const pruned = await prunePatchInstallJobs(cutoff);
  return NextResponse.json({ ok: true, pruned });
}
