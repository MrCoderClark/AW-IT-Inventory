import { NextResponse } from "next/server";

import {
  appendAgentEvents,
  finishSession,
  markSessionActive,
  type StatusOutcome,
} from "@/db/remote-sessions";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const MAX_CHUNK = 64 * 1024; // cap one output chunk

/** Map a fenced-write outcome to an HTTP response. */
function fenceError(outcome: StatusOutcome): NextResponse | null {
  if (outcome === "notfound")
    return NextResponse.json({ error: "no such session" }, { status: 404 });
  if (outcome === "stale")
    return NextResponse.json({ error: "stale claim" }, { status: 409 });
  return null;
}

/**
 * The collector worker's output + status channel for a session (spec 24, AC-4).
 * One POST can: mark the session `active` (runspace opened), append a batch of
 * stdout/stderr/status chunks, and/or finalize it (`closed`/`failed`). All writes
 * are fenced by the claim (`workerId` + `claimedAt`) → 409 on a stale claim.
 * Service token with `remote:agent`.
 */
export async function POST(request: Request, context: Context) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  const identity = await verifyServiceToken(token, "remote:agent");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing remote:agent scope" },
      { status: 403 },
    );

  let body: {
    workerId?: unknown;
    claimedAt?: unknown;
    status?: unknown;
    events?: unknown;
    error?: unknown;
  } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const workerId = typeof body?.workerId === "string" ? body.workerId : "";
  const claimedAt = typeof body?.claimedAt === "string" ? body.claimedAt : "";
  if (!workerId || !claimedAt)
    return NextResponse.json(
      { error: "workerId and claimedAt are required" },
      { status: 400 },
    );
  const fence = { workerId, claimedAt };
  const { id } = await context.params;

  // 1) Transition to active (runspace opened), if requested.
  if (body?.status === "active") {
    const err = fenceError(await markSessionActive(id, fence));
    if (err) return err;
  }

  // 2) Append output/status chunks, if any.
  const rawEvents: unknown[] = Array.isArray(body?.events) ? body.events : [];
  if (rawEvents.length) {
    const events = rawEvents
      .filter(
        (e): e is { channel?: unknown; data?: unknown } =>
          typeof e === "object" && e !== null,
      )
      .map((e) => ({
        channel:
          e.channel === "stderr"
            ? ("stderr" as const)
            : e.channel === "status"
              ? ("status" as const)
              : ("stdout" as const),
        data: typeof e.data === "string" ? e.data.slice(0, MAX_CHUNK) : "",
      }));
    if (events.length) {
      const err = fenceError(await appendAgentEvents(id, fence, events));
      if (err) return err;
    }
  }

  // 3) Finalize, if requested.
  const finalStatus =
    body?.status === "closed"
      ? ("closed" as const)
      : body?.status === "failed"
        ? ("failed" as const)
        : null;
  if (finalStatus) {
    const errText = typeof body?.error === "string" ? body.error : undefined;
    const err = fenceError(
      await finishSession(id, fence, finalStatus, errText),
    );
    if (err) return err;
  }

  return NextResponse.json({ ok: true });
}
