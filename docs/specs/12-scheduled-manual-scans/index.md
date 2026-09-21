# 12. Scheduled and manual scans

**Date**: 2026-09-21
**Status**: In Progress

## Summary

OPUS gains two related abilities driven by one always on collector process (a
"worker"). First, an admin can start an on demand scan of one computer, several
selected computers, or every known device, from the web UI; the worker picks the
job up and runs it. Second, the worker pings every manually entered printer three
times a day (default 08:00, 13:00, 18:00) to record whether it is up or down, does
one fuller SNMP read each morning, and when a printer stays unreachable it flags it
in the UI and emails the admins. The collector stays outbound only (it reaches out
to the web app; nothing ever connects into the fleet), so both abilities are built
as the worker pulling work and pushing results, never the web app connecting in.

## Requirements

**User stories**:
- As an IT admin, I want to trigger a scan of specific computers on demand, so I get
  fresh hardware and health without waiting for a scheduled run or a terminal.
- As an IT admin, I want to re scan every known device with one button, so I can
  refresh the whole inventory after a change.
- As an IT admin, I want printers checked three times a day, so I have an up or down
  record and learn quickly when one goes offline.
- As an IT admin, I want an email when a printer goes down and when it comes back, so
  I do not have to watch a dashboard.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: An admin holding `scan:write` can trigger a scan of a single computer from
  its detail page. This creates a `scan_jobs` row with status `pending`; the worker
  runs it and posts the results, and the computer's data updates.
- **AC-2**: An admin can select several computers in the Computers table and scan them
  in one job, and a global "Scan all" button enqueues a job whose targets are every
  known device IP (all `machines` plus every printer asset IP), snapshotted at
  creation, with no fresh network discovery.
- **AC-3**: The worker claims exactly one pending job at a time atomically (two workers
  polling never run the same job twice), runs the scan, posts results through the
  existing `/api/ingest/scan`, then marks the job `succeeded`, or `failed` only on a
  worker level error. A target that is unreachable is recorded per target and does not
  fail the job.
- **AC-4**: A job left in `claimed` or `running` past a timeout is returned to
  `pending` so a crashed worker never strands it.
- **AC-5**: The jobs view lists scan jobs newest first with status and a result summary.
  If no worker has polled within the heartbeat window, pending jobs show a "waiting for
  collector" state.
- **AC-6**: The worker checks every manually entered printer asset's IP three times a
  day at configurable times (default 08:00, 13:00, 18:00 local), recording reachability
  (up or down plus latency) each time; the first check of the day (08:00) also performs
  a full SNMP collect.
- **AC-7**: After 2 consecutive failed checks a printer is marked down (the UI shows a
  down state) and aw-auth emails every admin once, through Resend. One recovery email is
  sent on the first success after being down. No duplicate emails are sent while it
  stays down.
- **AC-8**: Reachability history and current status are stored and surfaced in the UI: a
  reachability badge and recent check history on the printers table and printer detail
  page.
- **AC-9**: Starting any manual scan is gated on `scan:write`; worker job and report
  endpoints require a service token carrying `scan:dequeue`; the web to aw-auth notify
  call requires `notify:send`. A user without `scan:write` sees no scan controls and is
  refused by the server action.
- **AC-10**: Reachability history older than the retention window (default 365 days) is
  pruned automatically by a daily worker task.

## Decision

**Chosen option**: Option 2: One long running collector worker (a queue poller plus an
in process scheduler).

The collector gains a `worker` command that stays running: it polls the web app for
manual scan jobs and drains them, and it runs an in process scheduler (APScheduler with
cron triggers) for the three times a day printer checks. Manual scans and scheduled
checks both flow as the worker pulling work and pushing results, matching the existing
outbound only ingest path. Alerting lives in aw-auth, which already owns users and roles
and now holds the Resend credentials, so it resolves "the admins" itself and sends the
mail. Web detects the up or down transition (it holds the history) and calls aw-auth to
send.

## Feature design

**Data model sketch** (web DB `aw_it_inventory`, Drizzle; four new tables):

`scan_jobs` (the manual scan queue)
- `id` uuid pk
- `scope` text not null: `all` | `selected`
- `targets` jsonb not null: array of IP strings, snapshotted at creation
- `status` text not null default `pending`: `pending` | `claimed` | `running` |
  `succeeded` | `failed` | `canceled`
- `requestedBy` text not null (user email from the access token; no FK, users live in
  aw-auth)
- `workerId` text null (the worker that claimed it)
- `runId` text null (the ingest run id the results were posted under)
- `result` jsonb null (fixed shape: `{ matched, discovered, upserted, skipped,
  targets: [{ ip, status }] }`)
- `error` text null (worker level error message when `status = failed`)
- `requestedAt` timestamptz not null default now; `claimedAt`, `startedAt`,
  `finishedAt` timestamptz null
- `createdAt`, `updatedAt` timestamptz
- partial index on (`status`, `requestedAt`) `WHERE status = 'pending'` (the claim query
  polls every few seconds; this keeps the claim cheap)

`printer_checks` (reachability history, one row per check)
- `id` uuid pk
- `assetId` uuid not null references `assets.id` on delete cascade
- `ipAddress` text not null (snapshot of the IP checked)
- `checkedAt` timestamptz not null default now
- `reachable` boolean not null
- `latencyMs` integer null
- `method` text not null: `tcp` | `snmp`
- `source` text not null: `scheduled` | `manual`
- index on (`assetId`, `checkedAt` desc)

`printer_status` (current rollup plus alert state, 1:1 with a printer asset)
- `assetId` uuid pk references `assets.id` on delete cascade
- `reachable` boolean null (last known)
- `lastCheckedAt` timestamptz null; `lastReachableAt` timestamptz null
- `consecutiveFailures` integer not null default 0
- `isDown` boolean not null default false
- `downSince` timestamptz null
- `lastAlertState` text not null default `up`: `up` | `down` (dedupe for alert emails)
- `updatedAt` timestamptz not null default now

`scan_workers` (heartbeat so the UI can tell whether a worker is polling)
- `workerId` text pk
- `lastPolledAt` timestamptz not null
- `version` text null

aw-auth DB (`aw_auth`): no new tables, and two distinct systems are involved, do not
conflate them. User permissions live in `seed_rbac.py` (`Permission`/`Role`, checked via
the access token `perms` claim); `scan:write` ("Trigger and configure scans") already
exists there and is already granted to `Owner` and `Admin`, so no seed change is needed to
gate the UI. Service token scopes are a separate freeform `ServiceAccount.scopes` field,
set per account (via `create_service_account` or the Django admin), never in `seed_rbac`.
So `scan:dequeue` is granted on the existing collector service account, and a new
`opus-web` service account is created with `notify:send`.

**State transitions**:
- scan job: `pending` -> `claimed` -> `running` -> `succeeded` | `failed`. Reaper:
  `claimed` | `running` past the timeout -> `pending`. User cancel: `pending` ->
  `canceled`. A status update is fenced by the claim: it is accepted only when the caller's
  `workerId` and `claimedAt` match the row's current claim, so a slow worker whose job the
  reaper already reclaimed (and a second worker re-ran) cannot overwrite the newer result
  (it gets 409).
- printer alert state: `up` -> `down` after 2 consecutive failed checks, `down` -> `up` on
  the first successful check after being down. Ordering is fixed: the reachability endpoint
  writes `printer_checks` and updates `printer_status` (including `lastAlertState`) in one
  transaction first, then fires the email; if the email send fails it is logged and left,
  the next scheduled check re-evaluates and retries the transition, so a send failure never
  crashes the pipeline and never double-fires. While `down`, further failures send nothing.

**API surface**:

| Endpoint / action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `requestScan` (server action) | action | scope, targets? (machine/asset ids) | job id | cookie + `scan:write` | 403 no perm, 422 no resolvable IPs |
| `cancelScanJob` (server action) | action | job id | ok | cookie + `scan:write` | 403, 409 not pending |
| `/api/scan/claim` | POST | workerId, version | one pending job (id, targets, workerId, claimedAt) or 204 | service `scan:dequeue` | 401, 403 |
| `/api/scan/jobs/{id}/status` | POST | workerId, claimedAt, status, result?, runId?, error? | ok | service `scan:dequeue` | 403, 404, 409 stale claim / bad transition |
| `/api/scan/reachability` | POST | checks[] (assetId, reachable, latencyMs, method, source, checkedAt) | ok, alerts fired | service `scan:dequeue` | 403, 422 |
| `/api/ingest/scan` (existing) | POST | hosts[] | matched, discovered, upserted | service `ingest:write` | 401, 403, 400 |
| `/v1/notify/printer-alert` (aw-auth) | POST | printer{name, ip}, event, since? | ok | service `notify:send` | 403, 422 |

The jobs view and printer status/history read straight from the DB in server
components (gated on `asset:read`); no extra read endpoints.

**Key invariants**:
- Atomic claim: the worker claims with a single `UPDATE ... WHERE id = (SELECT id FROM
  scan_jobs WHERE status='pending' ORDER BY requestedAt LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING`, so no job runs twice even with two workers.
- `targets` are frozen at creation as a de-duplicated list of IP strings; an "all" job
  scans the device set as of enqueue time, not as of run time. Resolution: for `all`, union
  `machines.ip` with each printer asset's `printer_details.ipAddress`; for `selected`,
  resolve the chosen machine/asset ids to their IPs. `printer_details.ipAddress` is the
  source of truth for a printer and wins over a stale `machines.ip` for the same device, so
  the same physical device is never scanned twice under two IPs. A selected asset with no
  resolvable IP (never scanned, no `printer_details.ipAddress`) is dropped from `targets`;
  if that leaves the list empty, `requestScan` returns 422.
- A status update is accepted only from the worker that currently holds the claim
  (`workerId` + `claimedAt` match), else 409.
- `printer_status.isDown` is true exactly when `consecutiveFailures >= 2`. Exactly one
  down email per down episode and one recovery email per recovery, enforced by
  `lastAlertState` (see the alert ordering in State transitions).
- An unreachable target during a manual scan is recorded, never a job failure; `failed`
  means the worker itself errored.
- Secrets never live in the DB or code: `RESEND_API_KEY` only in `aw-auth/.env`, the
  `opus-web` client secret only in `web/.env`.

- `scan:write` (an existing aw-auth permission, held by `Owner` and `Admin`, rides the
  access token `perms` claim like `columns:write` in spec 11) gates `requestScan` and
  `cancelScanJob`; the UI hides the scan controls without it and the server action re checks
  the claim.
- Worker endpoints (`/api/scan/*`) verify a service token with `scan:dequeue` through the
  existing JWKS path, the same way `/api/ingest/scan` checks `ingest:write`.
- The aw-auth notify endpoint requires `notify:send`; web calls it with a new `opus-web`
  service account (client credentials, the same grant the collector uses). aw-auth resolves
  "admins" as active users holding the `Owner` or `Admin` role with a non-empty email; if
  none resolve, it logs and sends nothing.
- No regulated data is involved (internal IT inventory on a private network).

**Configuration required**:
- `aw-auth/.env`: `RESEND_API_KEY`, `EMAIL_FROM` (already set by the engineer).
- `web/.env`: `OPUS_WEB_CLIENT_ID`, `OPUS_WEB_CLIENT_SECRET` (the new `opus-web` service
  account, for the notify call), and the aw-auth base URL if not already present.
- `collector` config: worker poll interval (default 5s), schedule times (default
  `["08:00","13:00","18:00"]`), the schedule timezone (an explicit `schedule_timezone`,
  default the host local zone, so APScheduler fire times do not drift with the host OS or
  DST), the daily full SNMP time (default the first, 08:00), reachability TCP ports (default
  `[9100, 631, 515]`), TCP connect timeout, the stuck job timeout (the reaper window), and
  the reachability retention days (default 365). Existing web base URL and collector service
  credentials are reused, but the collector's service account must be granted the new
  `scan:dequeue` scope (see Build plan task 1).

**Critical test scenarios** (each maps to an AC in Requirements):
- Happy path: an admin clicks "Scan now" on a computer, the worker claims and runs it,
  results land through ingest, the job shows `succeeded`. Verifies AC-1, AC-3.
- Failure case: two workers poll at once; the atomic claim gives the job to exactly one.
  Verifies AC-3. A worker crashes mid job; the reaper returns it to `pending`. A slow worker
  whose job was reclaimed then posts a status update; the claim fence rejects it with 409 so
  the newer result stands. Verifies AC-4.
- Reachability and alert: a printer misses 2 checks in a row, gets marked down, and one
  admin email is sent; the next success sends one recovery email and no repeats in
  between. Verifies AC-6, AC-7.
- Notify failure: Resend is unreachable when a transition fires; the status write still
  commits, the failure is logged, the pipeline does not crash, and the next check retries
  the pending transition. Verifies AC-7.
- Auth/permission: a user without `scan:write` sees no scan controls and the server action
  refuses them; a service token missing `scan:dequeue` is rejected by the worker
  endpoints. Verifies AC-9.

## Build plan

Build approach: none is recorded in `AGENTS.md` or the scope header, so this plan uses
Tracer Bullet slices (a thin thread through every layer first, then thicken). Assumption
stated here for the record.

1. Foundations. (a) Add `scan_jobs` (with the partial pending index), `printer_checks`,
   `printer_status`, `scan_workers` to `web/src/db/schema.ts` and run `db:push`. (b) RBAC:
   no `seed_rbac.py` change is needed for the UI gate, `scan:write` already exists and is
   granted to `Owner`/`Admin`; instead grant the new `scan:dequeue` scope on the existing
   collector service account, and create a new `opus-web` service account with `notify:send`
   (both via `create_service_account` or the Django admin, since there is no "update scopes"
   command today). Satisfies **AC-1**, **AC-9** (foundation).
2. Manual scan thread, end to end for one computer. Add `main.py worker` (the long
   running loop), `POST /api/scan/claim` (atomic claim plus heartbeat upsert), run the
   targeted collect, post results to `/api/ingest/scan`, then `POST
   /api/scan/jobs/{id}/status`. Add the `requestScan` server action and the "Scan now"
   button on the computer detail page. Satisfies **AC-1**, **AC-3**.
3. Batch and global. Add Computers table multi select ("Scan selected") and the global
   "Scan all" button that resolves and snapshots every known device IP into `targets`.
   Satisfies **AC-2**.
4. Jobs view and resilience. The jobs list (status plus result summary), the worker
   heartbeat surfaced as "waiting for collector", the stuck job reaper, and
   `cancelScanJob`. Satisfies **AC-4**, **AC-5**.
5. Printer reachability engine. Add the APScheduler cron jobs (08:00, 13:00, 18:00), the
   TCP connect probe (plus a full SNMP collect at 08:00), and `POST
   /api/scan/reachability` writing `printer_checks` and updating `printer_status`.
   Satisfies **AC-6**, **AC-8** (data).
6. Alerting. Detect the up or down transition on `printer_status`; add aw-auth `POST
   /v1/notify/printer-alert` that resolves admin users and sends through Resend; web
   calls it with the `opus-web` service token; dedupe on `lastAlertState`. Satisfies
   **AC-7**.
7. Printer UI and retention. The reachability badge and recent history on the printers
   table and detail page, and the daily retention prune task in the worker. Satisfies
   **AC-8**, **AC-10**.

## Consequences

**Positive**:
- One supervised process runs both features; there is a single place to operate, log,
  and restart, and a clean path to the planned Docker Compose (the same `worker` command
  becomes a `restart: unless-stopped` service).
- The outbound only posture is preserved: the web app never opens a connection into the
  fleet, so no inbound firewall holes on scanned hosts.
- Manual scans and ingest share one reconcile path (`/api/ingest/scan`), so results stay
  consistent with scheduled ingests.
- Alerting reuses aw-auth's identity and RBAC to resolve recipients, so "admins" stays
  correct as staff change, with no second recipient list to maintain.

**Negative / tradeoffs**:
- The worker must be installed and supervised (a Windows Service via WinSW or NSSM now).
  If it stops, manual scans queue and printer checks pause until it is back; the
  heartbeat surfaces this but does not fix it.
- `printer_status` deliberately stores derived values (`consecutiveFailures`, `isDown`,
  `lastAlertState`). This is a conscious exception to "compute at read time", made because
  correct once only alerting needs a persisted last alerted state anyway.
- A new `opus-web` service account and a web to aw-auth call path add a moving part that
  did not exist before (web previously only verified tokens locally).
- Email delivery depends on Resend and outbound internet from the aw-auth host; a send
  failure must be logged and not crash the check pipeline.

**Neutral**:
- New env vars and a new collector `worker` command to document and run.
- APScheduler is a new collector dependency (in process, no broker), and the worker is a
  new long running runtime shape for a project whose collector was previously run by hand.

## Follow-up

- [ ] Consider a Resend or email conventions doc under a nested `AGENTS.md`
  (`aw-auth`), since email sending is new to the project; capture the Resend usage and the
  `notify:send` contract there before implementation.
- [ ] Alert throttling and escalation (for example repeat reminders while still down, or a
  daily digest) are out of scope for v1; revisit if down printers are missed.
- [ ] `requestScan` resolves selected machine/asset ids and "all" to IPs; if scanning a
  whole location (a subtree of assets) becomes useful, extend the resolver to expand a
  location into its device IPs.
- [ ] Retention default (365 days) is a guess; confirm against how long reachability
  history is actually useful.

## Rationale

Reasoning, the options weighed, and the full context: see [rationale.md](rationale.md).
