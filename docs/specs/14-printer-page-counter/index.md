# 14. Printer page counter and daily report

**Date**: 2026-09-24
**Status**: In Progress

## Summary

OPUS reads each network printer's total page (life) counter over SNMP, keeps a
daily history of it, shows the latest count and the day's change on the printer's
detail page, and emails the admins a daily counter report. The counter is read on
the existing daily SNMP collect (spec 12), so no new scan path is added; the read
uses a configurable OID (default the standard Printer-MIB life counter) so a
device like the Canon imageFORCE 520 that answers a vendor-specific OID can still
be read. An admin can also send the report on demand from the Admin page.

## Requirements

**User stories**:
- As an IT admin, I want to see how many pages a printer has printed, so I can
  track usage and plan supplies without walking to the device.
- As an IT admin, I want a daily email of each printer's total and how much it
  printed that day, so I have a usage record without opening the app.
- As an IT admin, I want to send that report on demand, so I can get a fresh
  number when I need one.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: The collector reads a printer's total page counter over SNMP using a
  configurable OID (default the standard `prtMarkerLifeCount`,
  `1.3.6.1.2.1.43.10.2.1.4.1.1`). The Canon imageFORCE 520's real counter OID is
  pinned during the build by walking the device, so its counter reads a value, not
  empty.
- **AC-2**: Each time a matched printer is read over SNMP and returns a numeric
  counter, the web app records a daily snapshot in `printer_counters`: one row per
  printer per calendar day, the latest read of the day winning. No new read
  endpoint; this rides the existing daily SNMP collect and `/api/ingest/scan`.
- **AC-3**: The printer detail page shows the latest total, today's delta (pages
  that day, computed day over day), and recent daily history. The delta shows
  "first reading" when there is no prior day, and "counter reset" when the value
  dropped (for example a swapped device), never a negative number.
- **AC-4**: A daily email is sent to the admins (active `Owner`/`Admin` users,
  resolved by aw-auth, the same recipients as spec 12's down alerts) at a
  configurable time (default 08:05 local, just after the 08:00 SNMP collect). It
  lists each printer with its total and today's delta; a printer with no reading
  that day is listed as "no reading", not dropped.
- **AC-5**: An admin holding `scan:write` can send the same report immediately from
  the Admin page ("Send counter report now"). A user without `scan:write` sees no
  button and is refused by the server action.
- **AC-6**: Counter history older than the retention window (default 365 days) is
  pruned by the worker's existing daily retention task.
- **AC-7**: The worker's report-send endpoint requires a service token with
  `scan:dequeue`; the web to aw-auth report call requires `notify:send` (the
  existing `opus-web` service account); the manual send requires `scan:write`.

## Decision

**Chosen option**: read the counter on the existing SNMP collect with a
configurable OID, store a daily snapshot per printer, and reuse spec 12's worker
scheduler plus the aw-auth Resend path for the email.

The counter is already read by the collector's SNMP collect (`page_count`) and the
value already flows to the web app inside `machines.printer` on every ingest. What
is missing is a durable, day indexed history (needed for a day over day delta), a
place in the UI to see it, and the email. So this feature adds one small history
table filled from the ingest it already receives, a detail-page panel, and a daily
report that reuses the parts spec 12 built (the worker's APScheduler and the
`opus-web` -> aw-auth -> Resend send path). The one genuinely new collection
concern is that the standard Printer-MIB counter OID is not guaranteed on a Canon
imageFORCE 520, so the read OID becomes configurable (default the standard one) and
the real OID is confirmed against the device during the build.

## Feature design

**Data model** (web DB `aw_it_inventory`, Drizzle; one new table):

`printer_counters` (daily counter snapshot, one row per printer per day)
- `assetId` uuid not null references `assets.id` on delete cascade
- `readingDate` date not null (calendar day in the schedule timezone)
- `totalPages` integer not null (the life counter read that day; latest wins)
- `lastReadAt` timestamptz not null default now (when that day's latest read ran)
- `source` text not null: `scheduled` | `manual` (which read set the value)
- `createdAt` timestamptz; `updatedAt` timestamptz
- primary key or unique on (`assetId`, `readingDate`)
- index on (`assetId`, `readingDate` desc) for the latest, the delta, and history

No rollup table: the latest total, the delta, and the report are all computed from
this history. `printer_details.pageCount` stays the manual admin-entered field and
is never overwritten by the live read (they are separate: manual metadata vs the
live meter).

**Delta rule**: today's delta = today's `totalPages` minus the `totalPages` of the
most recent prior day with a reading. No prior reading -> "first reading" (no
number). A negative result (the counter went down) -> "counter reset" (a replaced
or reset device), never shown as a negative.

**State / recording**: the collector's SNMP collect reads the configured
`counter_oid` into `page_count`. On ingest, for a host that is a printer, matched
to an asset, with a numeric `page_count`, the web app upserts the
(`assetId`, today) snapshot, setting `totalPages`/`lastReadAt`/`source` to the
latest. Idempotent per day: repeated scans the same day update the one row.

**API surface**:

| Endpoint / action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `sendCounterReportNow` (server action) | action | (none) | ok, sent count | cookie + `scan:write` | 403 no perm |
| `/api/scan/counter-report/send` | POST | (none) | ok, printers, sent | service `scan:dequeue` | 401, 403 |
| `/v1/notify/printer-counter-report` (aw-auth) | POST | printers[] {name, ip, total, delta, note} | ok, sent | service `notify:send` | 403, 422 |
| `/api/ingest/scan` (existing, extended) | POST | hosts[] | matched, discovered, upserted | service `ingest:write` | 401, 403, 400 |
| `/api/scan/reachability/prune` (existing, extended) | POST | retentionDays | ok, pruned | service `scan:dequeue` | 401, 403 |

The detail-page counter panel reads `printer_counters` straight from the DB in a
server component (gated `asset:read`); no extra read endpoint (as spec 12 does).
Both send paths (the server action and the worker endpoint) call one shared
`server-only` `sendCounterReport()` in web: it assembles the per-printer rows
(total + delta) and posts them to the aw-auth report endpoint with the `opus-web`
token. aw-auth resolves the admins and builds and sends the email through Resend.

**Key invariants**:
- One snapshot per (`assetId`, `readingDate`); the latest read that day wins, so
  recording is idempotent within a day.
- The live counter never overwrites the manual `printer_details.pageCount`.
- The email lists every managed printer; one with no snapshot for the target day
  reads "no reading" rather than being dropped.
- Secrets and accounts are reused, not added: the `opus-web` service account
  (`notify:send`) and `RESEND_API_KEY`/`EMAIL_FROM` from spec 12; no new ones.

**Configuration required**:
- `collector` config: `counter_oid` (default `1.3.6.1.2.1.43.10.2.1.4.1.1`), the
  daily report time `counter_report_time` (default `08:05`), reusing the existing
  `schedule_timezone`. The imageFORCE 520's real OID is set here once confirmed.
- `web/.env`: none new (reuses `OPUS_WEB_CLIENT_ID`/`OPUS_WEB_CLIENT_SECRET`).
- `aw-auth/.env`: none new (reuses `RESEND_API_KEY`/`EMAIL_FROM`).

**Critical test scenarios** (each maps to an AC):
- Read: the collector reads the configured OID; a printer returns a numeric
  counter; ingest writes one `printer_counters` row for today, and a second scan
  the same day updates it, not duplicates it. Verifies AC-1, AC-2.
- Delta: two days of readings show the correct day over day delta; a first ever
  reading shows "first reading"; a lower value than yesterday shows "counter
  reset". Verifies AC-3.
- Daily email: the scheduled send lists each printer's total and delta, includes a
  printer with no reading as "no reading", and reaches the admin recipients.
  Verifies AC-4.
- Manual send: an admin with `scan:write` clicks "Send counter report now" and the
  same email goes out; a user without it sees no button and the action refuses
  them. Verifies AC-5, AC-7.
- Retention: a snapshot older than the window is pruned by the daily task; recent
  ones remain. Verifies AC-6.

## Build plan

Build approach: none recorded in `AGENTS.md` or the scope header, so this uses
Tracer Bullet slices (a thin thread end to end first, then thicken), matching
spec 12. Assumption stated here for the record.

1. Foundations. Add `printer_counters` (with the unique key and index) to
   `web/src/db/schema.ts` and run `db:push`. Add `counter_oid` and
   `counter_report_time` to the collector config. Satisfies **AC-1**, **AC-2**
   (foundation).
2. Read and record thread, end to end for one printer. Point the collector's SNMP
   collect at the configured `counter_oid`; walk the real imageFORCE 520 to pin its
   OID and set it. Extend `ingestScan` to upsert today's `printer_counters` snapshot
   for a matched printer with a numeric counter. Satisfies **AC-1**, **AC-2**.
3. Detail-page panel. Add the counter panel (latest total, today's delta, recent
   daily history) to the printer detail page, reading `printer_counters`. Satisfies
   **AC-3**.
4. Daily report. Add the shared `sendCounterReport()` (assemble total + delta per
   printer), the aw-auth `POST /v1/notify/printer-counter-report` (resolve admins,
   build and send via Resend), and the worker's daily job at `counter_report_time`
   calling `POST /api/scan/counter-report/send`. Satisfies **AC-4**, **AC-7**.
5. Manual send. The Admin page "Send counter report now" button and the
   `sendCounterReportNow` server action (gated `scan:write`) calling the same
   `sendCounterReport()`. Satisfies **AC-5**.
6. Retention. Extend the worker's daily prune (and the prune endpoint) to also
   prune `printer_counters` past the retention window. Satisfies **AC-6**.

## Consequences

**Positive**:
- Reuses the spec 12 machinery (the SNMP collect, the worker scheduler, the
  `opus-web` -> aw-auth -> Resend path), so the new surface is small: one table, one
  UI panel, one report assembler, two thin endpoints.
- The configurable OID keeps the reader working across a mixed fleet and future
  models, not just the current Canon.
- The daily snapshot keeps the data tiny (one row per printer per day) while still
  giving a real day over day delta and a year of history.

**Negative / tradeoffs**:
- The Canon counter OID must be confirmed against the real imageFORCE 520 (an
  snmpwalk during the build); the standard default may read nothing until it is set.
- One printer, one number: mono/color and print/copy breakdowns are out of scope
  for v1 (see Follow-up), so the report is a single total per device.
- The delta depends on a reading existing for the prior day; a printer offline for a
  day shows "no reading" and the next delta spans two days.

**Neutral**:
- A new collector config value and a new daily worker job to run and document.

## Follow-up

- [ ] Confirm the imageFORCE 520's counter OID by walking the device
  (`snmpwalk` over the Canon enterprise tree, base `1.3.6.1.4.1.1602`), and record
  the working OID in the collector config and a short note in `collector/AGENTS.md`
  when that file exists.
- [ ] Per-model or per-profile OID overrides, if the fleet grows to Canon plus other
  vendors that need different OIDs (v1 uses one global `counter_oid`).
- [ ] Mono/color and print/copy counter breakdowns, if per-type usage is wanted
  later (needs the Canon MIB and more OIDs, plus wider `printer_counters` columns).
- [ ] A weekly or monthly rollup email, if the daily report proves too frequent.

## Rationale

Reasoning, the options weighed, and the full context: see [rationale.md](rationale.md).
