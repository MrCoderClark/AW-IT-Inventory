import "server-only";

import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { db } from "./index";
import { assets, notifications, notificationReads } from "./schema";
import type { AlertEvent } from "./reachability";
import type {
  NotificationItem,
  NotificationSeverity,
  NotificationType,
} from "@/lib/data";
import {
  publishNotification,
  type NotificationEvent,
} from "@/lib/notification-bus";

export type { NotificationItem, NotificationSeverity, NotificationType };

/* ================================================================
   Notification center data layer (spec 19). Admin-only broadcast:
   one row per event in `notifications`, per-user read state in
   `notification_reads`. Creation is idempotent on `dedupeKey` and
   best-effort (a failure never bubbles into the host operation that
   detected the event). Everything here is server-only.
   ================================================================ */

export interface CreateNotificationInput {
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  href: string;
  /** Idempotency key; re-creating with the same key is a no-op (AC-1). */
  dedupeKey: string;
  assetId?: string | null;
  meta?: Record<string, unknown> | null;
}

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Create a notification, idempotent on `dedupeKey` (AC-1). Returns the created
 * row's id, or `null` when it already existed (conflict) or on any error. On a
 * real insert it publishes to the bus so open SSE streams push (AC-7). Safe by
 * construction: every call site is best-effort, so a notification failure never
 * breaks the ingest / reachability / scan path that triggered it (AC-2).
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(notifications)
      .values({
        type: input.type,
        severity: input.severity,
        title: input.title,
        body: input.body,
        href: input.href,
        dedupeKey: input.dedupeKey,
        assetId: input.assetId ?? null,
        meta: input.meta ?? null,
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning();

    if (!row) return null; // already existed → no duplicate, no publish

    const event: NotificationEvent = {
      id: row.id,
      type: row.type,
      severity: row.severity,
      title: row.title,
      body: row.body,
      href: row.href,
      assetId: row.assetId,
      createdAt: isoOf(row.createdAt),
    };
    publishNotification(event);
    return row.id;
  } catch (err) {
    console.error(`[notifications] create failed (${input.dedupeKey}):`, err);
    return null;
  }
}

const DEFAULT_FEED_LIMIT = 30;

/** The notification feed for one admin, newest first, each with a `read` flag
   (left join on this user's reads). Keyset-paginated on `createdAt` via `before`
   (an ISO string); `unreadOnly` narrows to items this user has not read. */
export async function listNotifications(
  userKey: string,
  opts: { limit?: number; before?: string; unreadOnly?: boolean } = {},
): Promise<{ items: NotificationItem[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_FEED_LIMIT, 1), 100);

  const mine = eq(notificationReads.userKey, userKey);
  const conds = [
    opts.before ? lt(notifications.createdAt, new Date(opts.before)) : undefined,
    opts.unreadOnly ? isNull(notificationReads.notificationId) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      severity: notifications.severity,
      title: notifications.title,
      body: notifications.body,
      href: notifications.href,
      assetId: notifications.assetId,
      meta: notifications.meta,
      createdAt: notifications.createdAt,
      readAt: notificationReads.readAt,
    })
    .from(notifications)
    .leftJoin(
      notificationReads,
      and(eq(notificationReads.notificationId, notifications.id), mine),
    )
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(notifications.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextBefore =
    rows.length > limit ? isoOf(page[page.length - 1].createdAt) : null;

  const items: NotificationItem[] = page.map((r) => ({
    id: r.id,
    type: r.type,
    severity: r.severity,
    title: r.title,
    body: r.body,
    href: r.href,
    assetId: r.assetId,
    meta: r.meta,
    createdAt: isoOf(r.createdAt),
    read: r.readAt != null,
  }));

  return { items, nextBefore };
}

/** How many notifications this admin has not read (the bell badge). */
export async function getUnreadCount(userKey: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .leftJoin(
      notificationReads,
      and(
        eq(notificationReads.notificationId, notifications.id),
        eq(notificationReads.userKey, userKey),
      ),
    )
    .where(isNull(notificationReads.notificationId));
  return row?.count ?? 0;
}

/** Mark one notification read for this user (idempotent). Returns the new count. */
export async function markRead(
  userKey: string,
  notificationId: string,
): Promise<number> {
  await db
    .insert(notificationReads)
    .values({ notificationId, userKey })
    .onConflictDoNothing();
  return getUnreadCount(userKey);
}

/** Mark every currently-unread notification read for this user (one insert-select,
   bounded by retention). Returns the new count (0). */
export async function markAllRead(userKey: string): Promise<number> {
  await db.execute(sql`
    insert into notification_reads (notification_id, user_key)
    select n.id, ${userKey}
    from notifications n
    where not exists (
      select 1 from notification_reads r
      where r.notification_id = n.id and r.user_key = ${userKey}
    )
    on conflict do nothing
  `);
  return getUnreadCount(userKey);
}

/* ---------------- Printer transitions (AC-2) ---------------- */

/**
 * Create in-app notifications for the printer up/down transitions spec 12's
 * `recordChecks` returned, resolving each asset's tag for the deep link. Called
 * from the reachability route beside `sendPrinterAlert`; the two are independent
 * (a notification failure never affects the email, AC-2), and `createNotification`
 * is best-effort so this never throws into the route.
 *
 * Idempotency: a down uses the stable `downSince` (`printer-down:<id>:<downSince>`),
 * so an email-retry re-fire is deduped. A recovery's `since` is the volatile check
 * time, so its key is day-bucketed (`printer-recovery:<id>:<YYYY-MM-DD>`) — enough
 * to dedupe a same-episode retry without collapsing genuinely separate recoveries.
 */
export async function notifyPrinterTransitions(
  events: AlertEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const ids = [...new Set(events.map((e) => e.assetId))];
  const rows = await db
    .select({ id: assets.id, tag: assets.tag })
    .from(assets)
    .where(inArray(assets.id, ids));
  const tagById = new Map(rows.map((r) => [r.id, r.tag]));

  for (const e of events) {
    const tag = tagById.get(e.assetId);
    const href = tag ? `/assets/${tag}` : "/printers";
    if (e.event === "down") {
      await createNotification({
        type: "printer-down",
        severity: "critical",
        title: `Printer down: ${e.name}`,
        body: `${e.name} (${e.ip}) stopped responding${e.since ? ` on ${e.since.slice(0, 10)}` : ""}.`,
        href,
        dedupeKey: `printer-down:${e.assetId}:${e.since ?? ""}`,
        assetId: e.assetId,
        meta: { ip: e.ip, since: e.since },
      });
    } else {
      await createNotification({
        type: "printer-recovery",
        severity: "info",
        title: `Printer recovered: ${e.name}`,
        body: `${e.name} (${e.ip}) is reachable again.`,
        href,
        dedupeKey: `printer-recovery:${e.assetId}:${(e.since ?? "").slice(0, 10)}`,
        assetId: e.assetId,
        meta: { ip: e.ip, since: e.since },
      });
    }
  }
}

/* ---------------- Warranty sweep (AC-5) ---------------- */

const WARRANTY_WITHIN_DAYS = 30;
const DAY_MS = 86_400_000;

/** Whole days from today (UTC calendar day) to a YYYY-MM-DD string; negative =
   past. The same reference the Reports warranty report uses. */
function daysUntil(dateStr: string): number | null {
  const target = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.round((target - todayUtc) / DAY_MS);
}

/**
 * Create a notification for every asset whose warranty is expired or expiring
 * within `withinDays` (default 30), applying the same expired/expiring rule as
 * the Reports warranty report (AC-5). One per asset per warranty date
 * (`dedupeKey = warranty:<assetId>:<warrantyUntil>`), so the daily run never
 * spams; a changed warranty date yields a fresh notification. Returns how many
 * new notifications were created.
 */
export async function sweepWarrantyNotifications(
  opts: { withinDays?: number } = {},
): Promise<number> {
  const withinDays = opts.withinDays ?? WARRANTY_WITHIN_DAYS;
  const rows = await db
    .select({
      id: assets.id,
      tag: assets.tag,
      name: assets.name,
      warrantyUntil: assets.warrantyUntil,
    })
    .from(assets)
    .where(isNotNull(assets.warrantyUntil));

  let created = 0;
  for (const r of rows) {
    const date = (r.warrantyUntil ?? "").slice(0, 10);
    const daysLeft = daysUntil(date);
    if (daysLeft === null || daysLeft > withinDays) continue;

    const expired = daysLeft < 0;
    const id = await createNotification({
      type: "warranty-expiring",
      severity: expired ? "critical" : "warning",
      title: `${r.name}: warranty ${expired ? "expired" : "expiring"}`,
      body: expired
        ? `Warranty lapsed ${Math.abs(daysLeft)} day${daysLeft === -1 ? "" : "s"} ago (${date}).`
        : `Warranty expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${date}).`,
      href: `/assets/${r.tag}`,
      dedupeKey: `warranty:${r.id}:${date}`,
      assetId: r.id,
      meta: { tag: r.tag, warrantyUntil: date, daysLeft },
    });
    if (id) created += 1;
  }
  return created;
}

/* ---------------- Retention (AC-10) ---------------- */

const DEFAULT_RETENTION_DAYS = 90;

/** Delete notifications older than `days` (cascade clears their reads). Returns
   the deleted count. Folded into the existing daily prune job. */
export async function pruneNotifications(
  days = DEFAULT_RETENTION_DAYS,
): Promise<number> {
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - safeDays * DAY_MS);
  const rows = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, cutoff))
    .returning({ id: notifications.id });
  return rows.length;
}
