"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { markAllRead, markRead, type NotificationViewer } from "@/db/notifications";

export interface NotificationActionResult {
  ok: boolean;
  unread?: number;
  error?: string;
}

const FORBIDDEN: NotificationActionResult = {
  ok: false,
  error: "You don't have permission to manage notifications.",
};

/** Notifications stay admin-gated here. The viewer carries the stable per-user
   key (id, else email) plus email so the unread count is audience-filtered. */
async function requireAdminViewer(): Promise<NotificationViewer | null> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return null;
  return {
    userKey: user!.id || user!.email,
    email: user!.email,
    isAdmin: true,
  };
}

/** Mark one notification read for the current admin; returns the new unread count. */
export async function markNotificationReadAction(
  id: unknown,
): Promise<NotificationActionResult> {
  const viewer = await requireAdminViewer();
  if (!viewer) return FORBIDDEN;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Missing notification id." };
  }
  const unread = await markRead(viewer, id);
  revalidatePath("/notifications");
  return { ok: true, unread };
}

/** Mark every unread notification read for the current admin. */
export async function markAllNotificationsReadAction(): Promise<NotificationActionResult> {
  const viewer = await requireAdminViewer();
  if (!viewer) return FORBIDDEN;
  const unread = await markAllRead(viewer);
  revalidatePath("/notifications");
  return { ok: true, unread };
}
