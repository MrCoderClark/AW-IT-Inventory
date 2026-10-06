"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { markAllRead, markRead } from "@/db/notifications";

export interface NotificationActionResult {
  ok: boolean;
  unread?: number;
  error?: string;
}

const FORBIDDEN: NotificationActionResult = {
  ok: false,
  error: "You don't have permission to manage notifications.",
};

/** Notifications are admin-only (spec 19, AC-6); the stable per-user key is the
   user id, falling back to email. Returns null when the caller isn't an admin. */
async function requireAdminKey(): Promise<string | null> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return null;
  return user!.id || user!.email;
}

/** Mark one notification read for the current admin; returns the new unread count. */
export async function markNotificationReadAction(
  id: unknown,
): Promise<NotificationActionResult> {
  const userKey = await requireAdminKey();
  if (!userKey) return FORBIDDEN;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Missing notification id." };
  }
  const unread = await markRead(userKey, id);
  revalidatePath("/notifications");
  return { ok: true, unread };
}

/** Mark every unread notification read for the current admin. */
export async function markAllNotificationsReadAction(): Promise<NotificationActionResult> {
  const userKey = await requireAdminKey();
  if (!userKey) return FORBIDDEN;
  const unread = await markAllRead(userKey);
  revalidatePath("/notifications");
  return { ok: true, unread };
}
