import { NextResponse } from "next/server";

import { getRemoteSession, readEventsAfter } from "@/db/remote-sessions";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * The full recorded transcript of a past (or live) remote session (spec 24, AC-7):
 * the append-only event log, in order. Cookie-authenticated, gated on `remote:shell`
 * and owner-checked like the live stream — only the admin who ran it can read it.
 */
export async function GET(_req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "remote:shell"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await context.params;
  const session = await getRemoteSession(id);
  if (!session)
    return NextResponse.json({ error: "no such session" }, { status: 404 });
  if (session.requestedBy !== user.email)
    return NextResponse.json({ error: "not your session" }, { status: 403 });

  const events = await readEventsAfter(id, 0, ["input", "output", "system"], 5000);
  return NextResponse.json({
    events: events.map((e) => ({
      seq: e.seq,
      direction: e.direction,
      channel: e.channel,
      data: e.data,
    })),
  });
}
