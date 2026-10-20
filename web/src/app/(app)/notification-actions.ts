"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { markAllRead, markRead, type NotificationViewer } from "@/db/notifications";

export interface NotificationActionResult {
  ok: boolean;
  unread?: number;
  error?: string;
}

const SIGNED_OUT: NotificationActionResult = {
  ok: false,
  error: "Sign in to manage notifications.",
};

/** Any signed-in user may mark notifications. The viewer carries the stable
   per-user key (id, else email), email, and `user:admin` so unread counts and
   mark-all stay audience-filtered. */
async function requireViewer(): Promise<NotificationViewer | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return {
    userKey: user.id || user.email,
    email: user.email,
    isAdmin: hasPermission(user, "user:admin"),
  };
}

/** Mark one notification read for the current user; returns the new unread count. */
export async function markNotificationReadAction(
  id: unknown,
): Promise<NotificationActionResult> {
  const viewer = await requireViewer();
  if (!viewer) return SIGNED_OUT;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Missing notification id." };
  }
  const unread = await markRead(viewer, id);
  revalidatePath("/notifications");
  return { ok: true, unread };
}

/** Mark every unread notification visible to the current user as read. */
export async function markAllNotificationsReadAction(): Promise<NotificationActionResult> {
  const viewer = await requireViewer();
  if (!viewer) return SIGNED_OUT;
  const unread = await markAllRead(viewer);
  revalidatePath("/notifications");
  return { ok: true, unread };
}
