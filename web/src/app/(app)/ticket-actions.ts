"use server";

import { revalidatePath } from "next/cache";

import {
  addTicketComment,
  createTicket,
  createTicketFromNotification,
  setTicketAutoCreateType,
  updateTicket,
} from "@/db/tickets";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult, NotificationType } from "@/lib/data";
import { ALL_NOTIFICATION_TYPES } from "@/lib/data";
import {
  addTicketCommentInputSchema,
  createTicketInputSchema,
  firstTicketError,
  updateTicketPatchSchema,
} from "@/lib/ticket-schema";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to manage tickets.",
};

function revalidateTickets() {
  revalidatePath("/tickets");
}

function revalidateAdminTickets() {
  revalidatePath("/admin");
  revalidatePath("/tickets");
}

function isNotificationType(value: unknown): value is NotificationType {
  return (
    typeof value === "string" &&
    (ALL_NOTIFICATION_TYPES as readonly string[]).includes(value)
  );
}

function ticketNumberLabel(number: number): string {
  return `TKT-${number}`;
}

/**
 * Ticket CRUD and auto-create settings (spec 33). Gated on `user:admin`, rechecked
 * here so a viewer cannot invoke mutations even if they spoof the form.
 */
export async function createTicketAction(
  input: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  const parsed = createTicketInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstTicketError(parsed.error) };
  }

  const data = parsed.data;
  const result = await createTicket({
    subject: data.subject,
    description: data.description,
    priority: data.priority,
    category: data.category,
    assigneeEmail: data.assigneeEmail ?? null,
    assetId: data.assetId ?? null,
    createdBy: user!.email,
  });

  revalidateTickets();
  if ("existingId" in result) {
    return { ok: true, message: "That ticket already exists." };
  }
  return {
    ok: true,
    message: `Created ${ticketNumberLabel(result.number)}.`,
  };
}

export async function updateTicketAction(
  id: unknown,
  patch: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown ticket." };
  }

  const parsed = updateTicketPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return { ok: false, error: firstTicketError(parsed.error) };
  }

  const updated = await updateTicket(id, parsed.data);
  if (!updated) return { ok: false, error: "That ticket is no longer there." };

  revalidateTickets();
  return { ok: true, message: "Updated that ticket." };
}

export async function addTicketCommentAction(
  ticketId: unknown,
  body: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  if (typeof ticketId !== "string" || !ticketId) {
    return { ok: false, error: "Unknown ticket." };
  }

  const parsed = addTicketCommentInputSchema.safeParse({ body });
  if (!parsed.success) {
    return { ok: false, error: firstTicketError(parsed.error) };
  }

  const commentId = await addTicketComment(ticketId, {
    authorEmail: user!.email,
    body: parsed.data.body,
  });
  if (!commentId) {
    return { ok: false, error: "That ticket is no longer there." };
  }

  revalidateTickets();
  return { ok: true, message: "Comment added." };
}

export async function createTicketFromNotificationAction(
  notificationId: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  if (typeof notificationId !== "string" || !notificationId) {
    return { ok: false, error: "Unknown notification." };
  }

  const result = await createTicketFromNotification(
    notificationId,
    user!.email,
  );
  if (result === null) {
    return { ok: false, error: "That notification is no longer there." };
  }

  revalidateTickets();
  revalidatePath("/notifications");
  if ("existingId" in result) {
    return { ok: true, message: "A ticket already exists for that notification." };
  }
  return {
    ok: true,
    message: `Created ${ticketNumberLabel(result.number)} from the notification.`,
  };
}

export async function setTicketAutoCreateTypeAction(
  type: unknown,
  enabled: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  if (!isNotificationType(type)) {
    return { ok: false, error: "Unknown notification type." };
  }
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "Choose on or off." };
  }

  await setTicketAutoCreateType(type, enabled);
  revalidateAdminTickets();
  return {
    ok: true,
    message: enabled
      ? "Auto-create enabled for that type."
      : "Auto-create disabled for that type.",
  };
}
