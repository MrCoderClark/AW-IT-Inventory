import { NextResponse } from "next/server";

import { getAssistJob } from "@/db/ai-assist-jobs";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ jobId: string }> };

/** Status and result for the requester, or anyone with `user:admin`. */
export async function GET(_request: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { jobId } = await context.params;
  const job = await getAssistJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const isRequester =
    job.actorEmail.toLowerCase() === user.email.toLowerCase();
  if (!isRequester && !hasPermission(user, "user:admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    action: job.action,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    actorEmail: job.actorEmail,
    assetId: job.assetId,
  });
}
