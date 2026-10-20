import { after, NextResponse } from "next/server";

import { enqueueAssistJob, processAssistJob } from "@/db/ai-assist-jobs";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { AssistAction } from "@/lib/ai/types";

export const runtime = "nodejs";

const ACTIONS: AssistAction[] = [
  "summarize_health",
  "explain_failures",
  "summarize_script_run",
  "draft_script",
];

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    action?: unknown;
    assetTag?: unknown;
    jobId?: unknown;
    userPrompt?: unknown;
  } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const action =
    typeof body?.action === "string" &&
    ACTIONS.includes(body.action as AssistAction)
      ? (body.action as AssistAction)
      : null;
  const assetTag =
    typeof body?.assetTag === "string" ? body.assetTag.trim() : "";
  if (!action || !assetTag) {
    return NextResponse.json(
      { error: "action and assetTag are required" },
      { status: 400 },
    );
  }

  if (action === "draft_script") {
    if (!hasPermission(user, "software:deploy")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  } else if (!hasPermission(user, "asset:read")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const enq = await enqueueAssistJob({
    action,
    assetTag,
    actorEmail: user.email,
    scriptRunJobId: typeof body?.jobId === "string" ? body.jobId : undefined,
    userPrompt:
      typeof body?.userPrompt === "string" ? body.userPrompt : undefined,
  });

  if ("error" in enq) {
    if (enq.error === "not_configured") {
      return NextResponse.json(
        { error: "AI not configured", code: "ai_not_configured" },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "Computer not found" }, { status: 404 });
  }

  after(() => processAssistJob(enq.id));

  return NextResponse.json({ jobId: enq.id }, { status: 202 });
}
