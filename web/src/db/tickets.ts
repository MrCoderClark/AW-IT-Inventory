import "server-only";

import { and, desc, eq, ilike, inArray, max, or } from "drizzle-orm";

import { db } from "./index";
import {
  alertRules,
  assets,
  locations,
  notifications,
  people,
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
 * notification type. Auto-create is best-effort and never throws, and never
 * asks for an AI draft. `{ useAi: true }` (manual create only) fills fields
 * from a draft and falls back to the notification when that draft is missing
 * or fails.
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
  requesterEmail?: string | null;
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
    requesterEmail: row.requesterEmail ?? null,
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

/** Current device holder's email, when the asset is assigned to a person. */
export async function getAssetOwnerEmail(
  assetId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ email: people.email })
    .from(assets)
    .leftJoin(people, eq(assets.assigneeId, people.id))
    .where(eq(assets.id, assetId))
    .limit(1);
  const email = row?.email?.trim();
  return email || null;
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
  requesterEmail?: string | null;
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

  let requesterEmail = input.requesterEmail?.trim() || null;
  if (!requesterEmail && input.assetId) {
    requesterEmail = await getAssetOwnerEmail(input.assetId);
  }
  if (!requesterEmail) requesterEmail = input.createdBy;

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
          category: input.category?.trim() || "General",
          assigneeEmail: input.assigneeEmail ?? null,
          requesterEmail,
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
      requesterEmail: tickets.requesterEmail,
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
      requesterEmail: tickets.requesterEmail,
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
    requesterEmail: string | null;
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
  tx?: Tx,
): Promise<string | null> {
  // Optional tx lets a caller (inbound email) insert the comment in the same
  // transaction as its own writes. `db` is the default for direct callers.
  const q = (tx ?? db) as typeof db;
  const [ticket] = await q
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) return null;

  const [row] = await q
    .insert(ticketComments)
    .values({
      ticketId,
      authorEmail: input.authorEmail,
      body: input.body,
      kind: input.kind ?? "user",
    })
    .returning({ id: ticketComments.id });

  await q
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
  opts?: { useAi?: boolean },
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

  let subject = notif.title;
  let description = notif.body;
  let category = categoryFromNotificationType(notif.type);
  let priority: TicketPriority | undefined;

  if (opts?.useAi) {
    try {
      const { draftTicketFieldsFromNotification } = await import("./ai-ticket-draft");
      const draft = await draftTicketFieldsFromNotification(notificationId, createdBy);
      if (draft) {
        subject = draft.subject;
        description = draft.description;
        if (draft.category) category = draft.category;
        if (draft.priority) priority = draft.priority;
      }
    } catch {
      // A draft failure must not block creating the ticket from the notification.
    }
  }

  return createTicket({
    subject,
    description,
    assetId: notif.assetId,
    sourceNotificationId: notif.id,
    category,
    ...(priority !== undefined ? { priority } : {}),
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

function alertRuleIdFromMeta(
  meta: Record<string, unknown> | null | undefined,
): string | null {
  const v = meta?.alertRuleId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function maybeAutoCreateTicketFromNotification(row: {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  assetId: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    let mode: "inherit" | "on" | "off" = "inherit";
    const ruleId = alertRuleIdFromMeta(row.meta);
    if (ruleId) {
      const [rule] = await db
        .select({ ticketAutoCreate: alertRules.ticketAutoCreate })
        .from(alertRules)
        .where(eq(alertRules.id, ruleId))
        .limit(1);
      if (rule?.ticketAutoCreate === "on" || rule?.ticketAutoCreate === "off") {
        mode = rule.ticketAutoCreate;
      }
    }

    if (mode === "off") return;
    if (mode === "inherit") {
      const [cfg] = await db
        .select()
        .from(ticketAutoCreateTypes)
        .where(eq(ticketAutoCreateTypes.type, row.type))
        .limit(1);
      if (!cfg?.enabled) return;
    }
    await createTicketFromNotification(row.id, "system:auto");
  } catch (e) {
    console.error(`[tickets] auto-create failed (${row.id}):`, e);
  }
}
