import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { getUnreadCount } from "@/db/notifications";
import { subscribeNotifications } from "@/lib/notification-bus";

// A long-lived SSE connection must run on the Node runtime and never be cached
// or statically analysed as a normal response.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream for the notification bell (spec 19, AC-7). Cookie
 * auth + `user:admin`. On connect it sends the current unread count, then pushes
 * a `notification` event whenever one is created (via the in-process bus), with a
 * heartbeat comment every ~25s so proxies don't drop the idle connection. The
 * client re-syncs the count from the REST endpoint on each (re)connect, so a
 * missed event while disconnected self-heals; `EventSource` reconnects on its own.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (!hasPermission(user, "user:admin")) {
    return new Response("forbidden", { status: 403 });
  }

  const userKey = user.id || user.email;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client went away mid-write).
        }
      };
      const sendEvent = (event: string, data: unknown) =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Initial count so the badge is correct the moment the stream opens.
      const unread = await getUnreadCount(userKey).catch(() => 0);
      sendEvent("count", { unread });

      // Push every newly-created notification (admin-broadcast → all streams).
      const unsubscribe = subscribeNotifications((n) => {
        sendEvent("notification", n);
      });

      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Tear down when the client disconnects (navigates away / closes tab).
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
