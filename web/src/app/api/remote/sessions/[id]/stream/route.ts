import {
  getRemoteSession,
  readEventsAfter,
  type RemoteSessionStatus,
} from "@/db/remote-sessions";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";

// Long-lived streaming response needs the Node runtime (not edge/static).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const POLL_MS = 700;
const HEARTBEAT_MS = 15000;
const TERMINAL: RemoteSessionStatus[] = ["closed", "failed", "canceled"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Server-Sent Events stream of a session's output + status to its owner (spec 24,
 * AC-4). Cookie-authenticated, `remote:shell`, owner-checked. Resumes after the
 * client's `Last-Event-ID` (or `?after=`) so a reconnect never drops or duplicates
 * output (AC-7). Closes when the session reaches a terminal state. This holds a
 * connection open and polls the append-only log — fine on self-hosted Node.
 */
export async function GET(req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (!hasPermission(user, "remote:shell"))
    return new Response("forbidden", { status: 403 });

  const { id } = await context.params;
  const session = await getRemoteSession(id);
  if (!session) return new Response("no such session", { status: 404 });
  if (session.requestedBy !== user.email)
    return new Response("not your session", { status: 403 });

  const url = new URL(req.url);
  const resume =
    req.headers.get("last-event-id") ?? url.searchParams.get("after");
  let cursor = Number(resume) || 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const enqueue = (s: string) => {
        if (!closed) controller.enqueue(encoder.encode(s));
      };
      const sendEvent = (seq: number, payload: unknown) =>
        enqueue(`id: ${seq}\nevent: output\ndata: ${JSON.stringify(payload)}\n\n`);
      const sendStatus = (status: RemoteSessionStatus) =>
        enqueue(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);

      let lastStatus = session.status;
      sendStatus(lastStatus);
      let lastBeat = Date.now();

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (req.signal.aborted) break;

          const events = await readEventsAfter(id, cursor, ["output", "system"]);
          for (const e of events) {
            cursor = e.seq;
            sendEvent(e.seq, {
              seq: e.seq,
              direction: e.direction,
              channel: e.channel,
              data: e.data,
            });
          }

          const cur = await getRemoteSession(id);
          if (!cur) break;
          if (cur.status !== lastStatus) {
            lastStatus = cur.status;
            sendStatus(lastStatus);
          }
          if (TERMINAL.includes(cur.status)) break;

          if (Date.now() - lastBeat > HEARTBEAT_MS) {
            enqueue(`: keepalive\n\n`); // SSE comment, keeps proxies from closing
            lastBeat = Date.now();
          }
          await sleep(POLL_MS);
        }
      } catch {
        // client went away or the stream errored — fall through to close
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering if proxied
    },
  });
}
