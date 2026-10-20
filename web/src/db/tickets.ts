import "server-only";

import { and, desc, eq, ilike, inArray, max, or } from "drizzle-orm";

import { db } from "./index";
import {
  assets,
  locations,
  notifications,
  ticketAutoCreateTypes,
  ticketComments,
  tickets,
} from "./schema";
import {
  ALL_NOTIFICATION_TYPES,
  type NotificationType,
  type TicketCommentItem,
  type TicketListItem,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/data";

/**
 * Internal IT tickets (spec 33). CRUD, comments, create-from-notification with
 * dedupe on `sourceNotificationId`, and admin-configurable auto-create by
 * notification type. Auto-create is best-effort and never throws.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
}

/** Map a notification type to a ticket category (spec 33 plan). */
export function categoryFromNotificationType(type: NotificationType): string {
  switch (type) {
    case "metric-threshold":
    case "metric-recovered":
    case "compliance-at-risk":
    case "compliance-recovered":
    case "printer-down":
    case "printer-recovery":
      return "Alert";
    case "warranty-expiring":
      return "Warranty";
    case "device-discovered":
      return "Discovery";
    case "scan-failed":
      return "Scan";
    case "software-deploy":
    case "software-deploy-failed":
    case "patch-install":
    case "patch-install-failed":
    case "script-run":
    case "script-run-failed":
    case "printer-install":
    case "printer-install-failed":
      return "Ops";
    case "ai-assist":
    case "ai-assist-failed":
      return "Assist";
    default:
      return "General";
  }
}

function toListItem(row: {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: string;
  priority: string;
  category: string;
  assigneeEmail: string | null;
  assetId: string | null;
  sourceNotificationId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  assetTag?: string | null;
  assetName?: string | null;
  locationLabel?: string | null;
}): TicketListItem {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    description: row.description,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    category: row.category,
    assigneeEmail: row.assigneeEmail,
    assetId: row.assetId,
    assetTag: row.assetTag ?? null,
    assetName: row.assetName ?? null,
    locationLabel: row.locationLabel ?? null,
    sourceNotificationId: row.sourceNotificationId,
    createdBy: row.createdBy,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOf(row.updatedAt),
  };
}

async function nextTicketNumber(tx: Tx): Promise<number> {
  const [row] = await tx.select({ m: max(tickets.number) }).from(tickets);
  return (row?.m ?? 0) + 1;
}

export async function createTicket(input: {
  subject: string;
  description?: string;
  priority?: TicketPriority;
  category?: string;
  assigneeEmail?: string | null;
  assetId?: string | null;
  sourceNotificationId?: string | null;
  createdBy: string;
}): Promise<{ id: string; number: number } | { existingId: string }> {
  const sourceNotificationId = input.sourceNotificationId ?? null;

  if (sourceNotificationId) {
    const [existing] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.sourceNotificationId, sourceNotificationId))
      .limit(1);
    if (existing) return { existingId: existing.id };
  }

  try {
    return await db.transaction(async (tx) => {
      const number = await nextTicketNumber(tx);
      const [inserted] = await tx
        .insert(tickets)
        .values({
          number,
          subject: input.subject,
          description: input.description ?? "",
          priority: input.priority ?? "medium",
          category: input.category ?? "",
          assigneeEmail: input.assigneeEmail ?? null,
          assetId: input.assetId ?? null,
          sourceNotificationId,
          createdBy: input.createdBy,
        })
        .returning({ id: tickets.id, number: tickets.number });

      await tx.insert(ticketComments).values({
        ticketId: inserted.id,
        authorEmail: input.createdBy,
        body: "Ticket created",
        kind: "system",
      });

      return { id: inserted.id, number: inserted.number };
    });
  } catch (err) {
    if (sourceNotificationId && isUniqueViolation(err)) {
      const [existing] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.sourceNotificationId, sourceNotificationId))
        .limit(1);
      if (existing) return { existingId: existing.id };
    }
    throw err;
  }
}

export async function listTickets(filters?: {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: string;
  assigneeEmail?: string;
  q?: string;
}): Promise<TicketListItem[]> {
  const conditions = [];
  if (filters?.status) conditions.push(eq(tickets.status, filters.status));
  if (filters?.priority) conditions.push(eq(tickets.priority, filters.priority));
  if (filters?.category) conditions.push(eq(tickets.category, filters.category));
  if (filters?.assigneeEmail) {
    conditions.push(eq(tickets.assigneeEmail, filters.assigneeEmail));
  }
  if (filters?.q?.trim()) {
    const term = `%${filters.q.trim()}%`;
    conditions.push(
      or(ilike(tickets.subject, term), ilike(tickets.description, term))!,
    );
  }

  const rows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      description: tickets.description,
      status: tickets.status,
      priority: tickets.priority,
      category: tickets.category,
      assigneeEmail: tickets.assigneeEmail,
      assetId: tickets.assetId,
      sourceNotificationId: tickets.sourceNotificationId,
      createdBy: tickets.createdBy,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt,
      assetTag: assets.tag,
      assetName: assets.name,
      locationLabel: locations.name,
    })
    .from(tickets)
    .leftJoin(assets, eq(tickets.assetId, assets.id))
    .leftJoin(locations, eq(assets.locationId, locations.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tickets.updatedAt));

  return rows.map(toListItem);
}

export async function getTicket(
  id: string,
): Promise<(TicketListItem & { comments: TicketCommentItem[] }) | null> {
  const [row] = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      description: tickets.description,
      status: tickets.status,
      priority: tickets.priority,
      category: tickets.category,
      assigneeEmail: tickets.assigneeEmail,
      assetId: tickets.assetId,
      sourceNotificationId: tickets.sourceNotificationId,
      createdBy: tickets.createdBy,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt,
      assetTag: assets.tag,
      assetName: assets.name,
      locationLabel: locations.name,
    })
    .from(tickets)
    .leftJoin(assets, eq(tickets.assetId, assets.id))
    .leftJoin(locations, eq(assets.locationId, locations.id))
    .where(eq(tickets.id, id))
    .limit(1);

  if (!row) return null;

  const comments = await db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.ticketId, id))
    .orderBy(ticketComments.createdAt);

  const commentItems: TicketCommentItem[] = comments.map((c) => ({
    id: c.id,
    authorEmail: c.authorEmail,
    body: c.body,
    kind: c.kind,
    createdAt: isoOf(c.createdAt),
  }));

  return { ...toListItem(row), comments: commentItems };
}

export async function updateTicket(
  id: string,
  patch: Partial<{
    subject: string;
    description: string;
    status: TicketStatus;
    priority: TicketPriority;
    category: string;
    assigneeEmail: string | null;
    assetId: string | null;
  }>,
): Promise<boolean> {
  const [updated] = await db
    .update(tickets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tickets.id, id))
    .returning({ id: tickets.id });
  return Boolean(updated);
}

export async function addTicketComment(
  ticketId: string,
  input: {
    authorEmail: string;
    body: string;
    kind?: "user" | "system";
  },
): Promise<string | null> {
  const [ticket] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) return null;

  const [row] = await db
    .insert(ticketComments)
    .values({
      ticketId,
      authorEmail: input.authorEmail,
      body: input.body,
      kind: input.kind ?? "user",
    })
    .returning({ id: ticketComments.id });

  await db
    .update(tickets)
    .set({ updatedAt: new Date() })
    .where(eq(tickets.id, ticketId));

  return row?.id ?? null;
}

/** Map notification id → ticket id for notifications that already have a ticket. */
export async function getTicketIdsByNotificationIds(
  notificationIds: string[],
): Promise<Record<string, string>> {
  if (notificationIds.length === 0) return {};

  const rows = await db
    .select({
      id: tickets.id,
      sourceNotificationId: tickets.sourceNotificationId,
    })
    .from(tickets)
    .where(inArray(tickets.sourceNotificationId, notificationIds));

  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.sourceNotificationId) {
      map[row.sourceNotificationId] = row.id;
    }
  }
  return map;
}

export async function createTicketFromNotification(
  notificationId: string,
  createdBy: string,
): Promise<{ id: string; number: number } | { existingId: string } | null> {
  const [notif] = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      assetId: notifications.assetId,
    })
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .limit(1);

  if (!notif) return null;

  return createTicket({
    subject: notif.title,
    description: notif.body,
    assetId: notif.assetId,
    sourceNotificationId: notif.id,
    category: categoryFromNotificationType(notif.type),
    createdBy,
  });
}

export async function listTicketAutoCreateTypes(): Promise<
  { type: NotificationType; enabled: boolean }[]
> {
  const rows = await db.select().from(ticketAutoCreateTypes);
  const enabledByType = new Map(rows.map((r) => [r.type, r.enabled]));

  return ALL_NOTIFICATION_TYPES.map((type) => ({
    type,
    enabled: enabledByType.get(type) === true,
  }));
}

export async function setTicketAutoCreateType(
  type: NotificationType,
  enabled: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .insert(ticketAutoCreateTypes)
    .values({ type, enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: ticketAutoCreateTypes.type,
      set: { enabled, updatedAt: now },
    });
}

export async function maybeAutoCreateTicketFromNotification(row: {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  assetId: string | null;
}): Promise<void> {
  try {
    const [cfg] = await db
      .select()
      .from(ticketAutoCreateTypes)
      .where(eq(ticketAutoCreateTypes.type, row.type))
      .limit(1);
    if (!cfg?.enabled) return;
    await createTicketFromNotification(row.id, "system:auto");
  } catch (e) {
    console.error(`[tickets] auto-create failed (${row.id}):`, e);
  }
}
