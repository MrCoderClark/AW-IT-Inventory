import "server-only";

import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

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
import { resolveJobNotificationAudience } from "@/lib/job-notification-audience";
import type { NotificationAudience } from "@/lib/notification-visibility";

export type { NotificationItem, NotificationSeverity, NotificationType };

/* ================================================================
   Notification center data layer (spec 19 + spec 34 audience).
   Ops events stay audience=admins (one row, per-user reads).
   Requester-only events (AI Assist) use audience=user plus
   recipientEmail. Creation is idempotent on `dedupeKey` and
   best-effort (a failure never bubbles into the host operation that
   detected the event). Everything here is server-only.
   ================================================================ */

/** Who is reading the feed. `isAdmin` is `user:admin`; email matches user-targeted rows. */
export interface NotificationViewer {
  userKey: string;
  email: string;
  isAdmin: boolean;
}

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
  /** Default `admins` (ops broadcast). `user` is requester-only. */
  audience?: NotificationAudience;
  /** Required when audience is `user`. */
  recipientEmail?: string | null;
}

/** Rows this viewer may see: admin broadcasts, or a user-targeted row for their email. */
function audienceWhere(viewer: NotificationViewer) {
  const userMatch = and(
    eq(notifications.audience, "user"),
    sql`lower(${notifications.recipientEmail}) = lower(${viewer.email})`,
  );
  if (!viewer.isAdmin) return userMatch;
  return or(eq(notifications.audience, "admins"), userMatch);
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
  const audience = input.audience ?? "admins";
  const recipientEmail = input.recipientEmail ?? null;
  if (audience === "user" && !recipientEmail) {
    console.error(
      `[notifications] user audience requires recipientEmail (${input.dedupeKey})`,
    );
    return null;
  }

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
        audience,
        recipientEmail,
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
      audience: row.audience ?? audience,
      recipientEmail: row.recipientEmail ?? recipientEmail,
    };
    publishNotification(event);
    try {
      const { maybeAutoCreateTicketFromNotification } = await import("./tickets");
      await maybeAutoCreateTicketFromNotification({
        id: row.id,
        type: row.type as NotificationType,
        title: row.title,
        body: row.body,
        assetId: row.assetId,
        meta: (row.meta as Record<string, unknown> | null) ?? null,
      });
    } catch (e) {
      console.error(`[notifications] ticket auto-create failed (${row.id}):`, e);
    }
    return row.id;
  } catch (err) {
    console.error(`[notifications] create failed (${input.dedupeKey}):`, err);
    return null;
  }
}

const DEFAULT_FEED_LIMIT = 30;

/** The notification feed for one viewer, newest first, each with a `read` flag
   (left join on this user's reads). Admin broadcasts only when `viewer.isAdmin`;
   user-targeted rows only when the email matches (case-insensitive). Keyset-
   paginated on `createdAt` via `before` (an ISO string); `unreadOnly` narrows to
   items this user has not read. */
export async function listNotifications(
  viewer: NotificationViewer,
  opts: { limit?: number; before?: string; unreadOnly?: boolean } = {},
): Promise<{ items: NotificationItem[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_FEED_LIMIT, 1), 100);

  const mine = eq(notificationReads.userKey, viewer.userKey);
  const conds = [
    audienceWhere(viewer),
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

/** How many notifications this viewer has not read (the bell badge). */
export async function getUnreadCount(viewer: NotificationViewer): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .leftJoin(
      notificationReads,
      and(
        eq(notificationReads.notificationId, notifications.id),
        eq(notificationReads.userKey, viewer.userKey),
      ),
    )
    .where(and(isNull(notificationReads.notificationId), audienceWhere(viewer)));
  return row?.count ?? 0;
}

/** Mark one notification read for this user (idempotent). Returns the new count.
   No-ops (without inserting a read row) when the notification is not visible to
   this viewer — same audience rule as list/unread/mark-all. */
export async function markRead(
  viewer: NotificationViewer,
  notificationId: string,
): Promise<number> {
  const [visible] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), audienceWhere(viewer)))
    .limit(1);
  if (!visible) return getUnreadCount(viewer);

  await db
    .insert(notificationReads)
    .values({ notificationId, userKey: viewer.userKey })
    .onConflictDoNothing();
  return getUnreadCount(viewer);
}

/** Mark every currently-unread notification this viewer can see (same audience
   rule as list/unread). A non-admin never stamps read on `audience=admins`
   rows, and nobody stamps another person's user-targeted row. Returns the new
   count. */
export async function markAllRead(viewer: NotificationViewer): Promise<number> {
  const userKey = viewer.userKey;
  const email = viewer.email;
  const visible = viewer.isAdmin
    ? sql`and (
        n.audience = 'admins'
        or (n.audience = 'user' and lower(n.recipient_email) = lower(${email}))
      )`
    : sql`and n.audience = 'user' and lower(n.recipient_email) = lower(${email})`;
  await db.execute(sql`
    insert into notification_reads (notification_id, user_key)
    select n.id, ${userKey}
    from notifications n
    where not exists (
      select 1 from notification_reads r
      where r.notification_id = n.id and r.user_key = ${userKey}
    )
    ${visible}
    on conflict do nothing
  `);
  return getUnreadCount(viewer);
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

/* ---------------- Printer install/remove results (spec 19 × spec 20) ---------------- */

/**
 * Raise an in-app notification for a finished printer install/remove job, called
 * from `updateInstallJobStatus` the moment a job reaches a terminal state — beside
 * the install-history record the job already carries. Best-effort and idempotent
 * per job+status (`createNotification` dedupes on `dedupeKey`), so a re-posted
 * status never double-fires and a notification failure never affects the status
 * update. `list` ops are silent: that's a background panel refresh, not a
 * user-facing event. The job's asset tag resolves the deep link.
 */
export async function notifyInstallResult(job: {
  jobId: string;
  action: "install" | "list" | "remove";
  status: "succeeded" | "failed";
  assetId: string;
  printerName: string | null;
  error?: string | null;
  requestedBy: string;
}): Promise<void> {
  if (job.action === "list") return;

  const { audience, recipientEmail } = resolveJobNotificationAudience(job.requestedBy);

  const [asset] = await db
    .select({ tag: assets.tag, name: assets.name })
    .from(assets)
    .where(eq(assets.id, job.assetId))
    .limit(1);

  const href = asset ? `/assets/${asset.tag}` : "/assets";
  const on = asset?.name ?? "the computer";
  const printer = job.printerName ? `"${job.printerName}"` : "a printer";
  const v =
    job.action === "remove"
      ? { past: "removed", noun: "removal", gerund: "Removing", prep: "from" }
      : { past: "installed", noun: "install", gerund: "Installing", prep: "on" };
  const ok = job.status === "succeeded";
  const err = (job.error ?? "").trim().slice(0, 300);

  await createNotification({
    type: ok ? "printer-install" : "printer-install-failed",
    severity: ok ? "info" : "warning",
    title: ok ? `Printer ${v.past}` : `Printer ${v.noun} failed`,
    body: ok
      ? `${printer} was ${v.past} ${v.prep} ${on}.`
      : `${v.gerund} ${printer} ${v.prep} ${on} failed${err ? `: ${err}` : "."}`,
    href,
    dedupeKey: `printer-install:${job.jobId}:${job.status}`,
    assetId: job.assetId,
    meta: { jobId: job.jobId, action: job.action, printerName: job.printerName },
    audience,
    recipientEmail,
  });
}

/**
 * Raise an in-app notification when a software deployment finishes (spec 23). Best-
 * effort + idempotent per deployment+status, like the printer-install notification;
 * the deep link goes to the target computer.
 */
export async function notifyDeployResult(job: {
  deploymentId: string;
  status: "succeeded" | "failed";
  assetId: string;
  packageName: string;
  packageVersion: string;
  error?: string | null;
  requestedBy: string;
}): Promise<void> {
  const { audience, recipientEmail } = resolveJobNotificationAudience(job.requestedBy);

  const [asset] = await db
    .select({ tag: assets.tag, name: assets.name })
    .from(assets)
    .where(eq(assets.id, job.assetId))
    .limit(1);

  const href = asset ? `/assets/${asset.tag}` : "/assets";
  const on = asset?.name ?? "the computer";
  const pkg = `"${job.packageName}" ${job.packageVersion}`;
  const ok = job.status === "succeeded";
  const err = (job.error ?? "").trim().slice(0, 300);

  await createNotification({
    type: ok ? "software-deploy" : "software-deploy-failed",
    severity: ok ? "info" : "warning",
    title: ok ? "Software deployed" : "Software deploy failed",
    body: ok
      ? `${pkg} was deployed to ${on}.`
      : `Deploying ${pkg} to ${on} failed${err ? `: ${err}` : "."}`,
    href,
    dedupeKey: `software-deploy:${job.deploymentId}:${job.status}`,
    assetId: job.assetId,
    meta: {
      deploymentId: job.deploymentId,
      packageName: job.packageName,
      packageVersion: job.packageVersion,
    },
    audience,
    recipientEmail,
  });
}

/**
 * Raise an in-app notification when a patch install finishes (spec 31 phase 3).
 * Best-effort + idempotent per job+status, like software deploy.
 */
export async function notifyPatchInstallResult(job: {
  jobId: string;
  status: "succeeded" | "failed";
  assetId: string;
  osCount: number;
  appCount: number;
  error?: string | null;
  requestedBy: string;
}): Promise<void> {
  const { audience, recipientEmail } = resolveJobNotificationAudience(job.requestedBy);

  const [asset] = await db
    .select({ tag: assets.tag, name: assets.name })
    .from(assets)
    .where(eq(assets.id, job.assetId))
    .limit(1);

  const href = asset ? `/assets/${asset.tag}` : "/assets";
  const on = asset?.name ?? "the computer";
  const parts: string[] = [];
  if (job.osCount) parts.push(`${job.osCount} OS update${job.osCount === 1 ? "" : "s"}`);
  if (job.appCount)
    parts.push(`${job.appCount} app upgrade${job.appCount === 1 ? "" : "s"}`);
  const what = parts.join(" + ") || "selected updates";
  const ok = job.status === "succeeded";
  const err = (job.error ?? "").trim().slice(0, 300);

  await createNotification({
    type: ok ? "patch-install" : "patch-install-failed",
    severity: ok ? "info" : "warning",
    title: ok ? "Patch install finished" : "Patch install failed",
    body: ok
      ? `${what} installed on ${on}.`
      : `Installing ${what} on ${on} failed${err ? `: ${err}` : "."}`,
    href,
    dedupeKey: `patch-install:${job.jobId}:${job.status}`,
    assetId: job.assetId,
    meta: {
      jobId: job.jobId,
      osCount: job.osCount,
      appCount: job.appCount,
    },
    audience,
    recipientEmail,
  });
}

/**
 * Raise an in-app notification when a scheduled reboot finishes (spec 31 v2).
 * Best-effort + idempotent per job+status, like patch install.
 */
export async function notifyRebootResult(job: {
  jobId: string;
  assetId: string;
  status: "succeeded" | "failed" | "canceled";
  requestedBy: string;
  scheduledAtIso: string;
  error?: string | null;
}): Promise<void> {
  const { audience, recipientEmail } = resolveJobNotificationAudience(job.requestedBy);

  const [asset] = await db
    .select({ tag: assets.tag, name: assets.name })
    .from(assets)
    .where(eq(assets.id, job.assetId))
    .limit(1);

  const href = asset ? `/assets/${asset.tag}` : "/assets";
  const on = asset?.name ?? "the computer";
  const err = (job.error ?? "").trim().slice(0, 300);

  const ok = job.status === "succeeded";
  const canceled = job.status === "canceled";

  await createNotification({
    type: ok || canceled ? "reboot" : "reboot-failed",
    severity: ok || canceled ? "info" : "warning",
    title: ok
      ? "Scheduled reboot completed"
      : canceled
        ? "Scheduled reboot canceled"
        : "Scheduled reboot failed",
    body: ok
      ? `Forced reboot completed on ${on}.`
      : canceled
        ? `Scheduled reboot on ${on} was canceled.`
        : `Scheduled reboot on ${on} failed${err ? `: ${err}` : "."}`,
    href,
    dedupeKey: `reboot:${job.jobId}:${job.status}`,
    assetId: job.assetId,
    meta: {
      jobId: job.jobId,
      scheduledAtIso: job.scheduledAtIso,
    },
    audience,
    recipientEmail,
  });
}

/**
 * Tell the requester that an AI Assist job finished (spec 34). User-targeted
 * only — ops broadcasts stay on the default audience. Idempotent per job and
 * outcome (`ai-assist:<jobId>:ok|fail`).
 */
export async function notifyAiAssistResult(input: {
  jobId: string;
  actorEmail: string;
  assetTag: string;
  assetId: string | null;
  action: string;
  ok: boolean;
  error?: string | null;
}): Promise<string | null> {
  const href = `/assets/${input.assetTag}?tab=monitoring&assistJob=${input.jobId}`;
  return createNotification({
    type: input.ok ? "ai-assist" : "ai-assist-failed",
    severity: input.ok ? "info" : "warning",
    title: input.ok ? "AI Assist finished" : "AI Assist failed",
    body: input.ok
      ? `Assist (${input.action}) is ready.`
      : `Assist (${input.action}) failed${input.error ? `: ${input.error.slice(0, 200)}` : "."}`,
    href,
    dedupeKey: `ai-assist:${input.jobId}:${input.ok ? "ok" : "fail"}`,
    assetId: input.assetId,
    audience: "user",
    recipientEmail: input.actorEmail,
    meta: { jobId: input.jobId, action: input.action },
  });
}

/**
 * Raise an in-app notification when a script run finishes (spec 32).
 */
export async function notifyScriptRunResult(job: {
  jobId: string;
  status: "succeeded" | "failed";
  assetId: string;
  scriptName: string;
  error?: string | null;
  requestedBy: string;
}): Promise<void> {
  const { audience, recipientEmail } = resolveJobNotificationAudience(job.requestedBy);

  const [asset] = await db
    .select({ tag: assets.tag, name: assets.name })
    .from(assets)
    .where(eq(assets.id, job.assetId))
    .limit(1);

  const href = asset ? `/assets/${asset.tag}` : "/assets";
  const on = asset?.name ?? "the computer";
  const name = `"${job.scriptName}"`;
  const ok = job.status === "succeeded";
  const err = (job.error ?? "").trim().slice(0, 300);

  await createNotification({
    type: ok ? "script-run" : "script-run-failed",
    severity: ok ? "info" : "warning",
    title: ok ? "Script finished" : "Script failed",
    body: ok
      ? `${name} ran on ${on}.`
      : `${name} on ${on} failed${err ? `: ${err}` : "."}`,
    href,
    dedupeKey: `script-run:${job.jobId}:${job.status}`,
    assetId: job.assetId,
    meta: { jobId: job.jobId, scriptName: job.scriptName },
    audience,
    recipientEmail,
  });
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
