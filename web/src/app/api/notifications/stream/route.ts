import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { getUnreadCount } from "@/db/notifications";
import { subscribeNotifications } from "@/lib/notification-bus";
import { notificationVisibleTo } from "@/lib/notification-visibility";

// A long-lived SSE connection must run on the Node runtime and never be cached
// or statically analysed as a normal response.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream for the notification bell (spec 19, AC-7 / spec 34).
 * Cookie auth: any signed-in user may connect. On connect it sends the current
 * unread count, then pushes a `notification` event only when that event is
 * visible to this viewer (admin broadcasts stay admin-only; user rows match
 * email). A heartbeat comment every ~25s keeps proxies from dropping the idle
 * connection. The client re-syncs the count from the REST endpoint on each
 * (re)connect, so a missed event while disconnected self-heals; `EventSource`
 * reconnects on its own.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const isAdmin = hasPermission(user, "user:admin");

  const viewer = {
    userKey: user.id || user.email,
    email: user.email,
    isAdmin,
  };
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
      const unread = await getUnreadCount(viewer).catch(() => 0);
      sendEvent("count", { unread });

      // Push a newly-created notification only when this viewer may see it.
      const unsubscribe = subscribeNotifications((n) => {
        if (
          !notificationVisibleTo(
            { email: user.email, isAdmin },
            { audience: n.audience, recipientEmail: n.recipientEmail },
          )
        ) {
          return;
        }
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
