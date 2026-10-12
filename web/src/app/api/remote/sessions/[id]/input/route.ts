import { NextResponse } from "next/server";

import { appendInput } from "@/db/remote-sessions";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * The session owner sends one input line to their remote terminal (spec 24, AC-4).
 * Cookie-authenticated, gated on `remote:shell`, and owner + active checked in the
 * db layer (AC-5). The line is appended to the session log; the collector picks it
 * up via its long-poll.
 */
export async function POST(req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "remote:shell"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { text?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  // A line of input. Empty string is allowed (a bare Enter); only a non-string is
  // rejected. Cap the length so one POST can't append an unbounded row.
  const text = typeof body?.text === "string" ? body.text.slice(0, 8192) : null;
  if (text === null)
    return NextResponse.json({ error: "text is required" }, { status: 400 });

  const { id } = await context.params;
  const res = await appendInput(id, user.email, text);
  // Discriminate on the success case first so `res` narrows to the `{ seq }`
  // member; the error variant carries a union `outcome` with no `seq`.
  if (res.outcome === "ok")
    return NextResponse.json({ ok: true, seq: res.seq });
  if (res.outcome === "forbidden")
    return NextResponse.json({ error: "not your session" }, { status: 403 });
  if (res.outcome === "not-active")
    return NextResponse.json({ error: "session is not active" }, { status: 409 });
  return NextResponse.json({ error: "no such session" }, { status: 404 });
}
