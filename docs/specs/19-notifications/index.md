# 19. Notifications (in-app notification center)

**Date**: 2026-10-06
**Status**: Proposed

## Summary

The bell in the top bar is wired to a real, admin-facing notification center.
OPUS already **detects** the things an IT admin needs to know about — a printer
going down or recovering (spec 12), a scan job failing (spec 12), a brand-new
device appearing in the discovery inbox (ingest), and warranties about to lapse
(derivable from asset data, surfaced today only on the Reports page). This spec
turns those moments into durable, in-app notifications: the bell shows an unread
count, a panel lists recent items (each linking to the asset/job/inbox it is
about), and admins can mark items read or clear them all. New notifications reach
an open session live over Server-Sent Events. The existing printer email alerts
(spec 12) and counter-report email (spec 14) are unchanged.

## Requirements

**User stories**:
- As an IT admin, I want a running feed of operational events (printer down, scan
  failed, new device, warranty expiring) in the app, so I notice problems without
  living in my inbox or re-running reports.
- As an IT admin, I want the bell to show how many unread notifications I have and
  to update live, so the count is trustworthy without a manual refresh.
- As an IT admin, I want to click a notification and land on the asset, job, or
  inbox it is about, and to mark items read (individually or all at once), so the
  feed stays a to-do list, not noise.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: The system stores notifications in the inventory DB (`aw_it_inventory`),
  one row per distinct event. Creating a notification is **idempotent** on a
  `dedupeKey`: re-detecting the same event (a re-scan, a repeated sweep) never
  creates a duplicate.
- **AC-2**: A **printer down** transition and a **printer recovery** transition
  (spec 12, the `recordChecks` events) each create a notification, at the same hook
  that fires the existing email. The email path is unchanged; a notification-write
  failure never affects the email, and vice-versa.
- **AC-3**: A scan job that ends in **failed** (`updateJobStatus`) creates a
  notification linking to the scan jobs view. One notification per job
  (`dedupeKey = scan-failed:<jobId>`).
- **AC-4**: When ingest reconcile creates a **newly discovered** (unmatched, not
  previously seen) machine, a notification is created linking to the discovery
  inbox. One per machine ever (`dedupeKey = device-discovered:<machineId>`), so a
  re-scan of the same device does not re-notify.
- **AC-5**: A daily **warranty sweep** creates a notification for each asset whose
  warranty is expired or expiring within the threshold (default 30 days), linking
  to the asset. One per asset per warranty date
  (`dedupeKey = warranty:<assetId>:<warrantyUntil>`), so the daily sweep does not
  spam; changing an asset's warranty date can produce a fresh notification.
- **AC-6**: Notifications are **admin-only**. Only a user with `user:admin` sees the
  bell, the count, the panel, and the `/notifications` page; a non-admin sees no
  bell and the APIs refuse them. Read/unread state is **per user**: one admin
  reading an item does not change its state for another admin.
- **AC-7**: The bell shows the current user's unread count (capped display `9+`),
  and it updates **live** over Server-Sent Events when a notification is created —
  no manual refresh. On (re)connect the client re-syncs the count via the REST
  endpoint, so a missed stream event self-heals.
- **AC-8**: An admin can **mark one** notification read (also implied by clicking
  through to its target) and **mark all** read; the count and panel reflect it
  immediately, and the change persists across reloads and sessions.
- **AC-9**: A `/notifications` page lists all notifications (newest first) with
  their read state and type, filterable by read/unread and by type, with
  mark-all-read. Reachable from the bell panel ("View all") and admin nav.
- **AC-10**: Notifications older than the retention window (default 90 days) are
  pruned by the existing daily prune job; pruning a notification removes its
  read rows.

## Decision

**Chosen options** (see `rationale.md` for the alternatives weighed):
- **Store in `aw_it_inventory`, web-owned.** Notifications are about inventory
  events the web app already detects and owns. aw-auth stays a pure identity
  provider; this adds no tables there.
- **Admin-only broadcast with per-user read state.** One row per event (no per-user
  fan-out); every `user:admin` sees it; a `notification_reads` table records who has
  read what. Right-sized for a small on-prem admin team, and read state stays
  correct per person.
- **Live via Server-Sent Events**, with an in-process pub/sub bus and a REST
  re-sync on connect. Single long-lived GET stream per open admin session; no
  websockets, no polling loop.
- **In-app only in v1.** The spec 12/14 **emails are untouched**; no new aw-auth
  work. Email for the other event types is future work.

## Feature design

### Data model

Two additive tables in `web/src/db/schema.ts` (both brand new → NOT NULL columns
are safe). The event-type and severity unions are plain `text` with a `$type`
union (not pg enums), so a future type never needs an enum migration — the same
pattern as `scan_jobs.scope`/`status`.

`notifications` — one row per distinct operational event:
- `id` uuid PK
- `type` text `$type<'printer-down' | 'printer-recovery' | 'scan-failed' |
  'device-discovered' | 'warranty-expiring'>`, not null
- `severity` text `$type<'info' | 'warning' | 'critical'>`, not null — drives the
  dot color and sort emphasis
- `title` text not null — the one-line headline
- `body` text not null — the supporting detail
- `assetId` uuid null → `assets.id` `onDelete: set null` — the subject asset when
  there is one (printer, warranty, discovered→matched later); null otherwise
- `href` text not null — the in-app link to open (`/assets/<tag>`, `/scans`,
  `/scans/jobs`); stored as text so a later-deleted target degrades to a dead link,
  never a broken row
- `dedupeKey` text not null — the idempotency key (see AC-1); **partial-unique**
- `meta` jsonb null — small structured payload (ip, since, jobId, daysLeft…)
- `createdAt` timestamptz default now, not null

Indexes:
- `uniqueIndex('notifications_dedupe_uq').on(dedupeKey)` — the idempotency backstop.
- `index('notifications_created_idx').on(createdAt.desc())` — the feed order.

`notification_reads` — who has read what (per-user state, AC-6, AC-8):
- `notificationId` uuid → `notifications.id` `onDelete: cascade` (prune/retention
  removes reads with their notification, AC-10)
- `userKey` text not null — the reading user's stable id (the token `sub`, falling
  back to email); no FK, users live in aw-auth (same pattern as
  `scan_jobs.requestedBy`)
- `readAt` timestamptz default now, not null
- PK `(notificationId, userKey)`

**Unread for user U** = notifications with no `notification_reads` row for `U`.
Marking all read inserts a read row for each of U's currently-unread notifications
(a bounded batch, `onConflictDoNothing`). There is no per-user fan-out of the
notifications themselves.

### Data layer — `web/src/db/notifications.ts` (server-only)

- `createNotification(input)` — insert with `onConflictDoNothing` on `dedupeKey`;
  returns the created row or `null` when it already existed. **On a real insert**
  it publishes to the notification bus (below) so open streams push. Best-effort by
  convention at every call site: a throw is caught and logged, never bubbling into
  the host operation (ingest, a reachability write, a scan-status update).
- `listNotifications(userKey, { limit, before, unreadOnly })` — the feed with a
  per-row `read` flag (left join on reads for `userKey`), newest first, keyset-
  paginated on `createdAt`.
- `getUnreadCount(userKey)` — the badge number.
- `markRead(userKey, id)` / `markAllRead(userKey)` — insert read rows
  (`onConflictDoNothing`); return the new unread count.
- `sweepWarrantyNotifications({ withinDays })` — reuse the Reports warranty bucket
  logic (`web/src/db/reports.ts`) to select expired + ≤threshold assets and
  `createNotification` one each (deduped per asset+date). Returns a count.
- `pruneNotifications(days)` — delete rows older than the window; cascade clears
  reads. Returns the deleted count.

### In-process notification bus — `web/src/lib/notification-bus.ts`

A module-level singleton `EventEmitter`, stashed on `globalThis` so Next dev HMR
reuses one instance. `publish(event)` and `subscribe(cb): () => void`. All
notification creators and the SSE route run in the **same web server process**
(route handlers, server actions, the ingest API, the worker-facing scan endpoints
are all one Node process under `next start`/NSSM), so an in-process bus reaches
every open stream. **Known limitation:** if web is ever run as multiple processes,
the bus won't cross them — document the upgrade path (Postgres `LISTEN/NOTIFY` or a
Redis channel) as future work. On-prem single-host deploys are unaffected.

### Generation hooks (all best-effort, never fail the host op)

| Event | Hook point | type / severity | dedupeKey |
|---|---|---|---|
| Printer down | `api/scan/reachability/route.ts`, per `recordChecks` event (beside the existing `sendPrinterAlert`) | `printer-down` / critical | `printer-down:<assetId>:<downSince>` |
| Printer recovery | same hook, recovery event | `printer-recovery` / info | `printer-recovery:<assetId>:<downSince>` |
| Scan failed | where `updateJobStatus` (spec 12) sets `failed` | `scan-failed` / warning | `scan-failed:<jobId>` |
| Device discovered | ingest reconcile, the new-machine branch in `web/src/db/ingest.ts` | `device-discovered` / info | `device-discovered:<machineId>` |
| Warranty expiring | daily `sweepWarrantyNotifications` | `warranty-expiring` / warning (expired → critical) | `warranty:<assetId>:<warrantyUntil>` |

The printer email and the notification are independent writes at the same point:
either can fail without affecting the other (AC-2). The discovery and scan-failed
hooks sit at the existing reconcile / status-update code, not in a new scan path.

### API surface

- `GET /api/notifications?limit&before&unreadOnly` — cookie auth + `user:admin`;
  the feed for the current user plus the unread count.
- `GET /api/notifications/stream` — **SSE** (`runtime = "nodejs"`,
  `dynamic = "force-dynamic"`), cookie auth + `user:admin`. Emits the current unread
  count on connect, then a `notification` event on each bus publish (carrying the
  new count and the new item), with a `:` heartbeat comment every ~25s to survive
  proxies. `EventSource` auto-reconnects; the client re-syncs via the REST endpoint
  on each (re)connect so a dropped event self-heals (AC-7).
- Mark-read **server actions** in `web/src/app/(app)/notification-actions.ts`
  (cookie + `user:admin`): `markNotificationReadAction(id)`,
  `markAllNotificationsReadAction()` — matches the app's action pattern
  (people-actions, columns-actions) and revalidates the bell/page.
- `POST /api/scan/notifications/warranty-sweep` — service `scan:dequeue` scope (the
  same token path as the other `/api/scan/*` worker endpoints); runs the daily
  warranty sweep.
- **Retention** folds into the existing daily `POST /api/scan/reachability/prune`
  (which already prunes `printer_checks` + `printer_counters`): it also calls
  `pruneNotifications` (AC-10).

### Collector worker

Two cron entries on the worker scheduler, mirroring the counter-report job
(`worker.py`): a daily call to `warranty-sweep`, and the notification prune folded
into the existing daily reachability prune call. New config knob
`notification_sweep_times` (default once daily, e.g. `["07:00"]`) in
`collector/config.yaml` + `config.example.yaml`. No scanning or fleet access — the
worker only pokes web endpoints, same as spec 12/14.

### UI

- **`notification-bell.tsx`** (client) replaces the static bell in `top-bar.tsx`.
  It renders **only** for `user:admin` (via `useHasPermission`), so non-admins see
  no bell (AC-6). It takes an initial count + recent list (fetched in the app
  layout), opens a panel (dropdown on desktop, `Sheet` on mobile) of the ~10 most
  recent items, and subscribes to `/api/notifications/stream` with `EventSource`:
  it updates the badge on push and refetches the list when the panel is open or a
  push arrives. Badge caps at `9+`. "Mark all read" and "View all" (→
  `/notifications`) sit in the panel header. Each item: a severity dot
  (critical→`--destructive`, warning→`--status-maintenance`, info→`--primary`), a
  type icon, title, detail, relative time; clicking marks it read and navigates to
  `href`.
- **`/notifications`** page (server component, `user:admin`-gated): the full feed,
  newest first, with read/unread + type filters and mark-all-read; an `asset:read`
  non-admin never reaches it. Added to `NAV_MANAGE` behind the admin filter (like
  `/admin`).

### Permissions

Viewing, the stream, the page, and the mark-read actions are all gated on
`user:admin` (the same permission the sidebar already uses to show `/admin`). No
new aw-auth permission, no reseed. Generation is server-internal (ingest, the
reachability/scan endpoints, the worker-called sweep) and ungated by a user role;
the worker endpoints keep their service `scan:dequeue` scope.

## Out of scope (v1)

- **Email for the new types.** Only the existing spec 12/14 emails send; no new
  aw-auth notify endpoints.
- **Per-user preferences / mute / per-type opt-out**, and **non-admin audiences**
  (role targeting). The admin-broadcast model is deliberately uniform in v1.
- **Multi-process / multi-host web** fan-out (needs `LISTEN/NOTIFY` or Redis).
- **Push/mobile/desktop OS notifications.**

## Testing

- `notifications.test.ts` — `createNotification` idempotency (dedupeKey conflict →
  no duplicate, returns null, no bus publish), unread count, `markRead`/
  `markAllRead`, `sweepWarrantyNotifications` bucketing/dedupe, `pruneNotifications`.
- Route tests — `GET /api/notifications` (admin gate + shape), the warranty-sweep
  endpoint (service-scope gate), and an SSE smoke test (connect → initial count →
  a published event is received).
- Hook tests — the reachability route still emails **and** now creates a
  notification (both, independently); `updateJobStatus(failed)` creates one; ingest
  reconcile creates one for a new machine and **not** on a re-seen one.
- `notification-bell` component test — renders only for admins, badge caps at `9+`,
  mark-all clears the count.

## Rollout / activation

1. `cd web && npm run db:push` — adds `notifications` + `notification_reads`.
2. Restart web (SSE route + bell live) and the collector `worker` (picks up the
   warranty-sweep cron and the folded prune).
3. Verify: force a printer down (or wait for a real transition) → an email **and**
   a bell notification; fail a scan job → a notification; a fresh discovered device
   → a notification; set an asset's warranty to yesterday and run the sweep → a
   notification. Confirm the count updates live in a second admin tab, mark-all
   clears it, and a non-admin sees no bell.
