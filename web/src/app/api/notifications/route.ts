import { NextResponse } from "next/server";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { getUnreadCount, listNotifications } from "@/db/notifications";

// The feed and count change with every scan/sweep; never cache.
export const dynamic = "force-dynamic";

/**
 * The notification feed for the current user (spec 19 / spec 34). Cookie auth:
 * any signed-in user may read. Audience filtering lives in the data layer, so a
 * non-admin never receives `audience=admins` rows. Returns the page plus the
 * user's unread count for the bell. Query: `limit`, `before` (ISO keyset
 * cursor), `unread=1`.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const isAdmin = hasPermission(user, "user:admin");

  const viewer = {
    userKey: user.id || user.email,
    email: user.email,
    isAdmin,
  };
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const before = url.searchParams.get("before") ?? undefined;
  const unreadOnly = url.searchParams.get("unread") === "1";

  const [{ items, nextBefore }, unread] = await Promise.all([
    listNotifications(viewer, { limit, before, unreadOnly }),
    getUnreadCount(viewer),
  ]);

  return NextResponse.json({ items, nextBefore, unread });
}
