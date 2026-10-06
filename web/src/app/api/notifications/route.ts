import { NextResponse } from "next/server";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { getUnreadCount, listNotifications } from "@/db/notifications";

// The feed and count change with every scan/sweep; never cache.
export const dynamic = "force-dynamic";

/**
 * The notification feed for the current admin (spec 19). Cookie auth + the
 * existing `user:admin` permission (AC-6): a non-admin is refused. Returns the
 * page plus the user's unread count for the bell. Query: `limit`, `before` (ISO
 * keyset cursor), `unread=1`.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasPermission(user, "user:admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const userKey = user.id || user.email;
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const before = url.searchParams.get("before") ?? undefined;
  const unreadOnly = url.searchParams.get("unread") === "1";

  const [{ items, nextBefore }, unread] = await Promise.all([
    listNotifications(userKey, { limit, before, unreadOnly }),
    getUnreadCount(userKey),
  ]);

  return NextResponse.json({ items, nextBefore, unread });
}
