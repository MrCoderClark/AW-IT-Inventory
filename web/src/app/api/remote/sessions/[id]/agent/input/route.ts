import { NextResponse } from "next/server";

import { heartbeatSession, readEventsAfter } from "@/db/remote-sessions";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const LONGPOLL_MS = Number(process.env.REMOTE_INPUT_LONGPOLL_MS ?? 25000);
const POLL_MS = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The collector worker long-polls this for new input lines to run on the target
 * (spec 24, AC-4). Each poll heartbeats the session (fenced by the claim) so the
 * reaper leaves a live session alone, and returns the current status so the worker
 * learns about a `closing`/`canceled` request and can tear the runspace down. Ends
 * early (returns at once) when input is waiting or the session is no longer active.
 * Service token with `remote:agent`.
 */
export async function GET(request: Request, context: Context) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  const identity = await verifyServiceToken(token, "remote:agent");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing remote:agent scope" },
      { status: 403 },
    );

  const { id } = await context.params;
  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after")) || 0;
  const workerId = url.searchParams.get("workerId") ?? "";
  const claimedAt = url.searchParams.get("claimedAt") ?? "";
  if (!workerId || !claimedAt)
    return NextResponse.json(
      { error: "workerId and claimedAt are required" },
      { status: 400 },
    );
  const fence = { workerId, claimedAt };

  const deadline = Date.now() + LONGPOLL_MS;
  while (Date.now() < deadline && !request.signal.aborted) {
    const hb = await heartbeatSession(id, fence);
    if (hb.outcome === "notfound")
      return NextResponse.json({ error: "no such session" }, { status: 404 });
    if (hb.outcome === "stale")
      return NextResponse.json({ error: "stale claim" }, { status: 409 });

    const events = await readEventsAfter(id, after, ["input"]);
    if (events.length || hb.status !== "active")
      return NextResponse.json({ events, status: hb.status });

    await sleep(POLL_MS);
  }

  // Timed out with nothing new: report current status so the worker re-polls.
  const hb = await heartbeatSession(id, fence);
  if (hb.outcome === "notfound")
    return NextResponse.json({ error: "no such session" }, { status: 404 });
  if (hb.outcome === "stale")
    return NextResponse.json({ error: "stale claim" }, { status: 409 });
  return NextResponse.json({ events: [], status: hb.status });
}
