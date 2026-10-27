# OPUS — Progress Log

Status of the OPUS IT Inventory system. Newest first. Each item shipped to `main`
via a feature branch + PR.

**Legend:** ✅ done · 🚧 in progress · 🔜 planned

---

## In progress 🚧 — Software deploy polish slice 1 (branch `feat/software-deploy-polish`)

**Skip-if-installed** (`skipIf.product_installed` on package steps) and **per-step
timeouts** (`timeoutSec`, default 900s) on web schema/parser, collector run path,
package editor, and deploy history badges (skipped / timed out). Design:
`docs/superpowers/specs/2026-10-27-software-deploy-polish-design.md` · plan:
`docs/superpowers/plans/2026-10-27-software-deploy-polish.md`. **Slice 2–3**
(templates, break-glass export) still on this branch before PR.

## Decision — Spec 33 & Spec 31 v2 follow-ups won't do (2026-10-27)

No further work on Spec 33 (portal / create-from-mail / attachments) or remaining
Spec 31 v2 (WSUS, WUA approve-hide, etc.). Shipped slices stay; specs + roadmap
updated accordingly.

## Shipped ✅ — Ingest: preserve fields on empty CIM (merged #130)

Partial WinRM collects (null hostname/OS/hardware) no longer blank a prior good
`machines` row; collector tags `cim_collect_empty` when the shell has no identity.
Branch: `fix/ingest-cim-preserve-nulls`.

## Shipped ✅ — Device groups consumers (merged #129)

Saved device groups on Spec 30 alert rules (`alert_rules.device_group_id`,
membership without IP) and Spec 31 fleet **Install OS updates** (group resolve
with IP gate).
Design: `docs/superpowers/specs/2026-10-26-device-groups-consumers-design.md`.

## Shipped ✅ — Deploy to collector host (merged #128)

Self-target software/printer deploys write under the worker temp dir instead of
SMB to the box’s own IP (NTLM loopback `ACCESS_DENIED`). Wise ePad x86 COM
runbook: `docs/runbooks/wise-epad-x86-com.md`.
Branch: `fix/deploy-self-target-local-copy`.

## Shipped ✅ — Device groups v1 (merged #126)

Dynamic device groups (location + OS + compliance filters) as script Run on… /
schedule targets (`ScriptTargetSpec` mode `group`).
Design: `docs/superpowers/specs/2026-10-26-device-groups-design.md`.

## Shipped ✅ — Spec 32: Script on alert (merged #125)

Optional remediation script on Spec 30 metric alert rules: on episode **fire**,
enqueue a normal `script_run_jobs` row for the alerting computer
(`alert_rules.remediation_script_id`).
Design: `docs/superpowers/specs/2026-10-26-script-on-alert-design.md`.

## Shipped ✅ — Computer audit log (merged #123)

Fleet **`/audit`** page: unified computer action history (dual-write
`computer_audit_events`), Spec 26 **`computerAuditEvents`** report source, CSV export.
Design: `docs/superpowers/specs/2026-10-23-computer-audit-log-design.md`.

## Shipped ✅ — Spec 31 v2: Recurring reboot (merged #122)

Per-computer **daily/weekly** forced reboot on the Updates tab. `reboot_schedules`
materializes the next one-shot `reboot_jobs` child; collector due-tick + rematerialize
on terminal.
Design: `docs/superpowers/specs/2026-10-23-spec-31-v2-recurring-reboot-design.md`.

## Shipped ✅ — Spec 31 v2: Scheduled reboot (merged #121)

Standalone **Schedule reboot** on the Updates tab plus optional **Also reboot at…** when
enqueueing OS install (Updates or fleet `/patches`). `reboot_jobs` queue; collector reboots
at `scheduledAt` over WinRM.
Design: `docs/superpowers/specs/2026-10-22-spec-31-v2-scheduled-reboot-design.md`.

## Shipped ✅ — Spec 31 v2: Fleet OS multi-install (merged #119)

Multi-select on `/patches`, **Install OS updates** for all missing OS per host, global
concurrency cap (`PATCH_INSTALL_MAX_CONCURRENT`).
Design: `docs/superpowers/specs/2026-10-22-spec-31-v2-fleet-os-install-design.md`.

## Shipped ✅ — Spec 33: Ticket email-in (merged #117)

Reply-only inbound: `POST /api/ingest/email` appends a user comment when From is
the assignee or requester. No create-from-mail.
Design: `docs/superpowers/specs/2026-10-21-ticket-email-in-design.md`.

**Ops (before it works):** point the mailbox MX at Resend Receiving, set the
webhook URL to `https://<web>/api/ingest/email`, and from `web/` run
`npm run db:push` so `ticket_email_messages` exists. Web needs
`RESEND_WEBHOOK_SECRET` and `RESEND_API_KEY` (receive only; send stays on
aw-auth). An unset API key makes every delivery **500**, and Resend retries
until it stops.

Webhook results: invalid signature **401**; fetch null or a process throw
**500** (Resend retries); ignored, duplicate, and commented **200**.

## Shipped ✅ — Spec 33: Outbound ticket email (merged #116)

Email assignee on assign / user comment / status via aw-auth notify + Resend.
Design: `docs/superpowers/specs/2026-10-21-outbound-ticket-email-design.md`.

## Shipped ✅ — Spec 34 v2c: Ticket draft assist (merged #115)

Manual **Create ticket** from a notification uses Spec 34 `draft_ticket` when AI is
configured; auto-create stays raw. Design:
`docs/superpowers/specs/2026-10-21-ticket-draft-assist-design.md`.

## Shipped ✅ — Spec 33 v2 ticketing (merged #110–#113)

Completes Spec 33 phase 2 on `main`:

- **Waiting on user** (#110) — status `waiting_on_user` + Waiting KPI.
- **CSV list export** (#111) — Export filtered tickets from `/tickets`.
- **Simple SLA** (#112) — priority budgets, soft-pause, SLA Breached KPI, list/detail/CSV.
- **Per-alert-rule auto-create** (#113) — tri-state Inherit/On/Off on Spec 30 rules;
  `meta.alertRuleId` on metric notifications. **Needs `npm run db:push`** if not done.

Later: **email-in** (implemented on the branch above; not merged); then end-user portal.

## Shipped ✅ — Reporting engine (spec 26, merged #84–#87)

Custom report builder fully built: engine + `/reports/builder` + CSV/Excel/PDF
export + saved hub + scheduled email delivery + charts + folders + minimal SQL
push-down. Spec: `docs/specs/26-reporting-engine/`. Deploy once:
`db:push` (`report_definitions` / `report_schedules`) + `seed_rbac` for
`report:write` (+ admin re-login) + `npm install` for export libs.

## Shipped ✅ — Collector: bound WinRM calls so a wedged host can't hang a scan (merged `fix/collect-subcall-timeout`)

A host with a stuck Windows Update made the posture step's WUA COM query block
forever; pywinrm polls a running command indefinitely, so the whole collect hung
(and the hang wasn't caught — it's a block, not an exception). Now every WinRM
PowerShell call (the main collect + each best-effort enrichment step) runs under a
wall-clock cap (`winrm_timeout`, previously defined but unused): a timed-out call is
abandoned and, since it poisons the shared connection, the remaining enrichment
steps run on a fresh session. The Windows Update history query is additionally
wrapped in a PowerShell job with a 10s cap, so a wedged Update service yields
`updates = unknown` instead of losing the whole posture. New `_run_ps_timeout` helper
+ test; `winrm_timeout` documented. Diagnosed with `diag_winrm.py` + a step probe.

## Shipped ✅ — RBAC nav visibility audit (merged `feat/rbac-nav-visibility`)

Server enforcement was already solid everywhere; this closes the UI **visibility**
gaps so a user never sees a link to a page they can't open. `NavItem` gains a `perm`
and one `filterNavByPermissions` rule, applied in **both the sidebar and the ⌘K
command palette** (the palette previously filtered nothing — it showed every admin
destination to everyone). Perms: Software Library→`software:deploy`, Scans/Scan
Jobs→`scan:read`, Notifications/Users/Roles/Admin→`user:admin`. `/admin` tightened
from `scan:read` to `user:admin` (page + nav agree). People and Media restricted to
`asset:write` (pages, nav, and their read APIs) — device→person assignments stay
visible on the asset side, and person-profile links are de-linked for viewers in the
Assignment history + Reports. Gotcha: a Django `is_superuser` implicitly holds every
permission, so a "Viewer" who is also a superuser bypasses all role limits. Tests:
`app-sidebar.test.tsx` + `command-palette.test.tsx`.

## Shipped ✅ — Compliance alert email (spec 21 v2, merged #81 `feat/compliance-alert-email`)

Delivers compliance at-risk / recovered alerts to admins' inboxes (not just the
in-app bell). aw-auth `v1/notify/compliance-alert` + web `sendComplianceAlertEmail()`;
best-effort and non-gating on the evaluate path. No DB migration.

## Shipped ✅ — Compliance alerting (spec 21 v2, merged `feat/compliance-alerting`)

Makes compliance actionable: admins get notified when a computer's security posture
regresses, not just when they open the dashboard. A device goes **at-risk** when any
hard security check fails — **BitLocker / Antivirus / Secure Boot / TPM** (`fail`) —
firing one `compliance-at-risk` notification that names the failed checks; the return
to clean fires `compliance-recovered`.

- State machine mirrors the printer-reachability alert (spec 12): the last notified
  state lives in a new `compliance_status.alertedState` col and is advanced **only
  after a successful send**, so one alert per episode, one recovery, retries on a
  failed send, and never spam while a device stays at-risk.
- Pure rule `failingSecurityChecks` / `isAtRisk` (`compliance-score.ts`); soft fails
  (Updates/Disk `warn`) and unassessed devices never alert. `evaluateComplianceAlert`
  (`db/compliance.ts`) fires at ingest after the posture upsert — best-effort, never
  fails the scan. Delivered in-app (bell + `/notifications`, SSE), deep-linked to the
  computer's Compliance tab; email via aw-auth is a later follow-up.
- **Needs `db:push`** (the `alerted_state` column). Tests: compliance-score at-risk
  rule + the transition state machine.

## Shipped ✅ — Monitor discovery + auto-add (spec 25 follow-up, merged `feat/monitor-discovery`)

Turns scanned displays into managed Monitor assets. On `/monitors`, a **Discovered
displays** banner lists displays a scan read from a computer's EDID that aren't
inventoried yet, each with **Add to inventory** (opens New Monitor pre-filled) and
**Dismiss** (hides built-in laptop panels, docks, duplicates; survives re-scans via
a new `dismissed_monitors` table).

- **Auto-add external monitors at ingest**: a scanned display becomes a Monitor
  asset when its vendor is a **recognized brand** (`isExternalMonitor`: in
  `PNP_VENDORS`, not a built-in-panel maker) with a serial — inheriting the
  computer's **location and assignee** (through the custody engine, not a raw
  write). Idempotent by serial; built-in panels / unknown vendors / dismissed
  serials are skipped. Deleting a Monitor dismisses its serial (no re-resurrection).
- **Native resolution + refresh** parsed from the raw EDID preferred detailed-timing
  descriptor (collector `WmiMonitorDescriptorMethods` → `_edid_native_mode`), stored
  on `connected_monitors` (new `resolution`/`refresh_hz` cols) and the created
  monitor's `monitor_details`; shown on the Displays card. Verified live (Dell P2217H
  → 1920x1080 @ 60). Panel type / ports / curved aren't in EDID → stay manual.
- `AssetFormDialog` now pre-fills in create mode; `AssetTable` gained a `banner` slot.
  **Needs `db:push`** (dismissed_monitors + the two connected_monitors columns).

## Shipped ✅ — Connected monitors (spec 25, merged)

Each Windows scan reads attached displays' EDID (vendor/model/serial/year/size) into
a `connected_monitors` table (replaced per scan). A **Connected Displays** card on
the computer detail page lists them; a serial reconciliation links each to its
Monitor asset (or flags "not in inventory"), and the Monitor's page shows the
**Connected Computer** in reverse. PnP vendor codes → names (`pnp-vendors.ts`).

## Shipped ✅ — Software deployment (spec 23, merged)

Push software to managed computers as ordered, multi-step packages (script / MSI /
EXE install, with companion files + a `%DIR%` token for response files). Installers
live in an S3-compatible store (SeaweedFS); the collector's `deploy:agent` runs the
steps via a cmd batch wrapper (exact arg quoting, reliable wait). Per-step captured
output, finish notification, continue-on-failure toggle, retention prune, package
create/edit UI. Reuses the atomic-claim/fenced-status worker machinery.

## Shipped ✅ — Remote actions: interactive terminal (spec 24, merged)

An interactive remote PowerShell terminal to a managed computer from the UI (a REPL
relay over WinRM, not a PTY), needing `remote:agent` on the collector. Threaded
input↔output relay, max-duration cap, robbyrussell-style prompt with persistent cwd,
pwsh colored output (CLIXML noise stripped), session-history panel + transcript view.

## Shipped ✅ — Compliance & device health (spec 21, merged)

Security-posture collection, a per-device health score, and a fleet dashboard
(full spec `docs/specs/21-compliance/index.md`). v1 signal set: **BitLocker ·
Defender/AV · TPM · Secure Boot · Windows Update age · disk-full %**. Shipped in
three phases plus two production fixes:

- **Phase 1 — collect + store + score** (`feat/spec-21-compliance-phase1`): the
  collector reads the posture best-effort (unreadable ⇒ `null`/unknown); new
  `compliance_status` table (1:1 per Computer asset, upserted at ingest); pure
  `src/lib/compliance-score.ts` `scoreCompliance()` (0–100, fail-closed unknowns,
  "not assessed" when all unknown). Rubric: BitLocker 25 / AV 25 / Updates 20 /
  TPM 10 / Secure Boot 10 / Disk 10.
- **Phase 2 — per-device tab** (`feat/spec-21-compliance-phase2`): a Compliance
  tab on the computer detail page (score + 🟢🟡🔴 rows + limited-visibility /
  not-assessed states).
- **Phase 3 — fleet dashboard** (`feat/spec-21-compliance-phase3`): `/compliance`
  rebuilt — summary tiles (avg score, BitLocker/AV coverage, updates behind, not
  assessed) + a sortable, non-compliant-filterable computers-by-score table.
- **Fixes:** posture runs as a **separate `PS_POSTURE` WinRM call** — folding it
  into `PS_COLLECT` overflowed pywinrm's ~8 KB command line ("command line too
  long"), breaking every computer collect (`fix/pscollect-too-long`). AV detection
  uses **Security Center** as authoritative so a 3rd-party AV (which puts Defender
  in passive mode) reads as protecting, not "Defender off" (`fix/compliance-3rd-party-av`).
  And `getComplianceStatus` reads by **tag** (the app's `Asset.id`), not the uuid
  (`fix/compliance-read-by-tag`).

Follow-ups (not v1): local administrators, network-adapter enumeration, all
logged-on sessions, posture history/trend, remediation actions, alerting on a
failing check (spec 19 hook).

---

## Shipped ✅ — Cancel a stuck install job from the UI (merged, `feat/cancel-install-job`)

`cancelInstallJob` (web `db/printer-install.ts`) now releases a `claimed`/`running`
job, not just `pending`; the Printers panel shows **Cancel** on in-flight jobs with
a confirm. Fence-safe — a late worker status post no-ops against the canceled row.
Closes the gap that forced a manual DB edit to clear a stuck "Working…" job (e.g.
after the worker was restarted mid-job, before the 10-min reaper kicks in). No
migration (`status` is `text`). Test: `printer-install-actions.test.ts`.

---

## Shipped ✅ — WinRM base64 fallback chunk-size fix (merged, `fix/winrm-base64-chunk-size`)

The SMB-unavailable transfer fallback failed on chunk 0 with "command line too
long": `_CHUNK` was 8 KB, but pywinrm wraps each `run_ps` as
`powershell -encodedcommand <b64>` (UTF-16+base64, ~2.67×) through the WinRS cmd
shell (~8 KB line). Dropped `_CHUNK` to 2 KB (~5.6 KB line) plus a test asserting
every chunk command clears the limit. SMB stays the primary (and fast) transport.

---

## Shipped ✅ — Collector reports all profile failures (merged)

`collect_windows` now records **every** credential profile's result, not just the
last tried. `auth_failed_all_profiles (...)` lists each profile with its
*qualified* username and per-profile reason (`ps_exit_N …`, the exception, or
`no password in .env` for a skipped one) — the same per-profile truth
`diag_winrm.py` prints — so a failing host is diagnosable straight from the
ingest/drawer, no side-script needed. No-password profiles are skipped without an
auth attempt. Test: `collector/test_collect_windows.py`.

---

## Shipped ✅ — Printer-install notifications (merged, `feat/notify-printer-install`)

In-app notifications when a printer install/remove job finishes (spec 19 × 20).
`notifyInstallResult` (`web/src/db/notifications.ts`) fires from
`updateInstallJobStatus` on a terminal job — best-effort, idempotent per
job+status — surfaced in the bell + `/notifications` and deep-linked to the
computer. Two new `NotificationType`s (`printer-install` /
`printer-install-failed`); `notifications.type` is `text`, so **no migration**.
Also fixed `printer-install-actions.test.ts`, which had been merged broken
(incomplete `@/db/printer-install` mock + a stale `connection.replace`
expectation that never actually ran).

---

## Shipped ✅ — Remote printer install (spec 20) (merged, `docs/spec-20-remote-printer-install`)

Push-install a printer onto a managed computer from the UI (full spec in
`docs/specs/20-remote-printer-install/`). Reuses the outbound worker + atomic
claim/fenced-status machinery (spec 12) and the cut-out "pull bytes, do work,
post result" model (spec 18). Admin-set driver catalog is a **filesystem folder
of manifests** (`web/drivers/`, gitignored; format + example in
`web/drivers.example/`; integrity is a content hash over the package file tree,
frozen per job). v1 is single-computer.

- `printer_install_jobs` table; data layer `web/src/db/printer-install.ts`
  (atomic claim, fenced status, enqueue/list/remove, cancel, history). API under
  `/api/scan/printer-install/*` + `/printer-packages/[id]/bundle` (service
  `scan:dequeue`); server actions `printer-install-actions.ts` (`printer:install`
  RBAC, seeded to Owner/Admin).
- UI: a **Printers** tab on the computer detail page (install / list / remove,
  replace-existing toggle, per-step captured output, cancel, Overview summary
  card). Collector `install_printer.py` wired into the worker drain loop.
- **Transfer is SMB to `\\host\C$`** (smbprotocol); base64-over-WinRM is the
  fallback. Driver-cert trust (import the `.cat` signer into TrustedPublisher/Root)
  runs before pnputil. New deps: web **fflate**, collector **smbprotocol**.
- Onboarding runbook from the WinRM-auth debugging: `docs/runbooks/onboard-computer.md`.
- Open follow-ups: pnputil `3010` surfaced as "reboot required"; a confirm dialog
  on Remove; `printer_install_jobs` retention / "clear history"; ingest revalidates
  an open asset drawer so a scan auto-refreshes it.

---

## Shipped ✅ — In-app user management (merged, PR #52 `feat/user-management`)

In-app user & role management, closing the `/admin` "powered by aw-auth in a
later phase" gap (the admin/self endpoints spec 02 §4 designs). Email-free:
admins set/reset passwords (shown once), users change their own; no
forgot-password email flow. Touches only `aw-auth` + `web` — no Drizzle change,
no RBAC reseed (`user:admin` already seeded, held by Owner/Admin).

- **aw-auth:** `HasAppPerm` permission class (gates on the `user:admin` RBAC
  code); admin user list/create/detail/delete + set-password, read-only roles;
  self password-change, profile PATCH, session list/revoke over SimpleJWT
  tokens. Guards: can't deactivate/delete/de-admin yourself or strip the last
  active admin. URLs under `/v1/auth/*`.
- **web:** admin calls forwarded with the caller's **own** token
  (`src/lib/auth/admin.ts`) so aw-auth re-enforces RBAC (no privileged service
  account). Pages `/admin/users`, `/admin/users/[id]`, `/admin/roles`,
  `/account`; actions `users-actions.ts` + `account-actions.ts`.
- **People ↔ Users link by matching email** (no schema change): the two systems
  stay separate but surface each other — "Directory entry" / "OPUS access"
  panels, a Directory column, a Login badge on `/people`.

---

## Shipped ✅ — Dashboard redesign (merged, PR #51 `feat/update-dashboard-ui`)

Rebuilt `/dashboard` to the mock, mapping its slots to real OPUS data (no
fabricated trends).

- Live clock; KPI row (Total / In Use / Maintenance / In Storage, each a **real
  % of fleet**); Asset Status donut + Assets-by-Type bar chart; Recent Alerts
  (notifications for admins, discovered devices otherwise); Recent Assets table.
- **Admin-toggleable Asset Locations map**: Leaflet + Esri World Gray Canvas
  (FOSS, no API key). `locations` gains nullable `latitude`/`longitude` + a
  coordinates editor (`location:write`); `dashboard_widgets` table (absent = on);
  off → location list instead of tiles. Pin popups reverse-geocode via Nominatim.
  New dep **leaflet**.

---

## Shipped ✅ — Printer page count in list + export, printer-detail refactor (merged, `feat/printer-page-count-ui`)

Surfaced the printer page (life) counter on `/printers` and in its CSV export,
and migrated `printer-detail.tsx` onto the shared `detail-ui` primitives.

- New `getPrinterCounterMap` (`queries.ts`, DISTINCT ON latest reading per
  printer) attached in `getAssetsByType`; new spec-11 **Pages** column (sortable,
  "—" when no reading), exported by default via `assetCsvValue`.
- `printer-detail.tsx` now imports the shared `detail-ui` primitives instead of
  byte-identical local copies.

---

## Shipped ✅ — Ingest orphan cleanup (merged, `fix/ingest-orphan-cleanup`)

Removes the stale weak-keyed (`ip`/`hostname`) `machines` shadow row left when an
earlier scan couldn't read a hardware id and a later scan keys the same device by
`hardware_uuid`/`serial`. `ingest.ts` deletes it on the weak→strong matchKey
transition — scoped to this host, excluding the just-upserted row, never a row
linked to a *different* asset (recycled-DHCP-safe).

---

## Shipped ✅ — Notifications (spec 19) (merged, `feat/notifications`)

In-app, admin-facing notification center behind the top-bar bell, live over SSE
(`docs/specs/19-notifications/`).

- Schema: `notifications` (one row per event, `dedupeKey` unique) +
  `notification_reads` (per-user read state). Data layer
  `web/src/db/notifications.ts`: `createNotification` (idempotent, best-effort,
  publishes to an in-process SSE bus), list/unread/mark-read, retention prune.
- Event sources (all best-effort): printer down/recovery, scan-failed,
  device-discovered, daily warranty sweep. (Printer-install events were added
  later — see the top of this log.)
- UI: admin-only `NotificationBell` (badge + panel + live SSE) + `/notifications`
  page (All/Unread, load-more, mark-all). Collector `run_warranty_sweep` +
  `notification_sweep_times` cron.

---

## Shipped ✅ — Export (CSV) (merged, `feat/csv-export`)

The **Export** button on every asset table (which used to only toast "Export
started") now downloads a real CSV of the current view, built client-side from
already-loaded data. New pure helper `web/src/lib/csv.ts` (`assetCsvValue` +
`assetsToCsv`, RFC 4180) writes the resolved spec-11 columns for all rows
matching the current search/filters/sort, as `opus-<view>-<YYYY-MM-DD>.csv`.

---

## Shipped ✅ — Reports page (merged, `feat/reports-page`)

Replaced the `/reports` placeholder with real reports from existing data (no new
tables, no collector work). New `web/src/db/reports.ts`: `getWarrantyReport`
(expiry buckets + a 90-day action list), `getAgingReport` (age bands + oldest-15
refresh candidates), `getAssignmentSummary` (assigned vs. pool, top holders);
Software reuses `getSoftwareInventory` (spec 15). UI is a four-tab layout
(Warranty / Aging / Assignments / Software), `asset:read`-gated.

---

## Shipped ✅ — assets display the cut-out (toggle) (merged, `feat/asset-use-cutout`)

Per-image toggle so assets using a library image show the **cut-out** (transparent)
instead of the original, and back (spec 18 phase 3 follow-on).

- **Code complete, web tsc + 428 tests green; needs `db:push` + verify.**
  - Schema: `media.preferCutout` boolean (default false). **Needs `npm run db:push`.**
  - `media.ts` `setPreferCutout`; `setMediaPreferCutout` server action (`asset:write`,
    revalidates the media page + asset surfaces). The asset image route serves the
    `cutout` variant when `preferCutout` + a cut-out exist, else the original.
  - Cache-bust: the asset query joins `media` and emits an `imageVersion`
    (`imageId:[c<attempts>|o]`) threaded through `AssetImage`/`AssetImageUpload` and
    the table + three detail pages, so toggling actually updates the shown image
    instead of serving a stale cached one.
  - UI: a **Switch** ("Show cut-out on assets") on `/media/[id]` once a cut-out is done.
  - Tests: asset-image `route.test.ts` (prefers cut-out when toggled). **Next:
    `npm run db:push`; on a media image with a cut-out, toggle it and confirm the
    asset's photo flips to transparent and back; commit.**

---

## Shipped ✅ — spec 18 Phase 3: background removal (merged, `feat/media-cutout` + `fix/rembg-cpu-extra`)

rembg background removal for library images (spec 18, AC-9): request a cut-out, a
self-hosted worker produces a transparent PNG, the page shows it; failed/stuck jobs
retry. Async claim/result flow mirroring `scan_jobs`.

- **Code complete, web tsc + 426 tests green, collector 25 pass; needs db:push +
  rembg install + live verify.**
  - Schema: `media` gains `cutoutKey`, `cutoutStatus` (null|pending|processing|done|
    failed), `cutoutClaimedAt`, `cutoutWorkerId`, `cutoutAttempts` (+ partial pending
    index). **Needs `npm run db:push`.**
  - Web `media.ts`: `requestCutout` (enqueue/retry), `claimCutoutJob` (atomic claim +
    stale-reap, mirrors `claimNextJob`), `completeCutout` (fenced store). API:
    `POST /api/media/cutout/claim` (service `scan:dequeue`, returns original bytes
    base64) + `POST /api/media/cutout/[id]/result`; `requestCutoutAction` server
    action; `media-serve` now serves the `cutout` variant. UI: `media-cutout-control.tsx`
    on `/media/[id]` (request/retry, status, cut-out preview on a checkerboard,
    auto-poll while running).
  - Collector: `cutout_worker.py` (outbound-only claim→rembg→post); `rembg` is the
    opt-in `cutout` extra (lazy import). **Folded into the main `worker`**: when
    `rembg` is installed the worker also drains cut-out jobs (on `cutout_poll_interval`,
    default 60s), so the whole app is **3 processes** (aw-auth, web, worker). The
    standalone `main.py cutout` command remains for running it separately.
  - Tests: `media.test.ts` (requestCutout/completeCutout), the two cut-out route tests,
    `test_cutout_worker.py`. `CLAUDE.md` "Run it" documents the 3-process startup.

  **Activate:** `cd web && npm run db:push`; `cd collector && uv sync --extra cutout`,
  then just run the normal `uv run python main.py worker` (it prints "background
  removal on"). On a `/media/[id]` page click **Remove background** → the worker
  produces the cut-out → the page shows it. Commit.

---

## Shipped ✅ — scheduled computer sweep (merged, `feat/scheduled-computer-sweep`)

A recurring, targeted scan of the computers an admin **manually added** (a Computer
asset with an IP), on the worker's scheduler — not a subnet discovery.

- **Code complete, web tsc + tests green, collector 22 pass; needs live verify.**
  - Web: `listComputerScanTargets` (`queries.ts`, Computer assets with a
    `computer_details.ipAddress`) + `GET /api/scan/computers` (service `scan:dequeue`,
    mirrors `/api/scan/printers`) + route test.
  - Collector: `sweep.py` `run_computer_sweep` (fetch targets → WinRM-collect those
    IPs computers-only → ingest; **bypasses the discovery toggles** since the IPs are
    explicit); `computer_sweep_times` config knob; wired into the worker scheduler
    (`worker.py`) as a cron job per time; `config.example.yaml` documents it; tests in
    `test_sweep.py`.
  - Local `config.yaml` set to `computer_sweep_times: ["12:00"]` (daily). **Next:
    restart the worker (it logs "computer sweep 12:00" in the schedule line); it fires
    daily and scans every manually-added computer. Commit.**

---

## Shipped ✅ — scan overwrites asset fields (merged, `feat/scan-updates-asset`)

Make a collector scan authoritative over an asset's **technical** fields (user
request). On ingest, a matched asset's `serial` / `model` / `vendor` and (for a
Computer) `computer_details` `cpu` / `ramGb` / `operatingSystem` / `storage` are
overwritten from the scan — **only where the scan returned a value** (a field the
collector didn't read never blanks an existing one), and human/admin fields (name,
location, cost center, dates, assignee) are never touched. Implemented in
`web/src/db/ingest.ts` (`applyScanToAsset`, best-effort; `computer_details` upserted
since the 1:1 row may not exist yet). Test: `web/src/db/ingest.test.ts`. Type-check +
407 tests green. **Next: scan a machine, confirm its asset fields update; commit.**
Note: this was the fix for the earlier "0 reachable" report, which turned out to be a
DHCP/IP mismatch (the entered IP wasn't the machine) — no collector change needed for
that; this enrichment is the follow-on the user asked for.

---

## Shipped — spec 17 UI redesign complete (merged)

All five children merged to `main`: 01 design system, 02 image upload (later
superseded by spec 18 media), 03 printers, 04 computers (`feat/computers-redesign`,
PR #37), 05 monitors/phones/network (`feat/thin-categories-redesign`, PR #38). Every
asset type is on the new list layout + shared tabbed detail framework (`detail-ui.tsx`
/ `Tabs`). Follow-up: migrate `printer-detail.tsx` onto `detail-ui` (still has local
primitive copies).

---

## Earlier in progress — spec 17.05 thin categories (branch `feat/thin-categories-redesign`)

Finishing the spec 17 UI redesign: every asset type now on the new list layout +
shared tabbed detail framework.

- **17.05 monitors / phones / network 🚧 code complete, type-check + 403 tests green;
  needs UI verify.** New `web/src/components/thin-detail.tsx` (`ThinAssetDetail`) on
  the shared framework — Monitor/Phone → Overview / Assignment / Activity; Network →
  Overview / Network / Activity. Reusable pieces extracted to `detail-ui.tsx`
  (`ActivityTable`, `AssignmentTimeline`, `deriveActivity`) and a shared
  `assignment-controls.tsx`; `computer-detail.tsx` refactored onto them. Routing sends
  the three types to `ThinAssetDetail`; the superseded generic `asset-detail.tsx` (+
  test) was **removed** (all five types now have redesigned details). The three list
  pages got the new layout (hero, Status/Vendor/Model filters, "New <Type>"). Test:
  `thin-detail.test.tsx`. **Next: UI verify monitor/phone/network detail + lists;
  commit.**
- **17.04 computers ✅ committed (`feat/computers-redesign`).** Tabbed detail (Overview
  / Live scan / Software / Assignment / Activity) + new list layout; shared
  `detail-ui.tsx` framework introduced.
- **With 17.05, spec 17 (OPUS UI redesign) is complete** — design system, image
  upload, printers, computers, and the thin categories all on the new design.
  Remaining follow-up: migrate `printer-detail.tsx` onto `detail-ui` (it still uses
  local primitive copies; left untouched to avoid regressing the untested printers
  page). Spec 18 Phase 3 (rembg) is the only other open item.

---

## Shipped earlier — spec 18 media library UI redesign (branch `feat/media-ui`)

Shared, reusable asset images (spec 18, `docs/specs/18-media-library/`): one upload
reused across identical devices, deduped by content hash, with a `/media` library.
Supersedes spec 17.02's single-`imageKey` storage model.

- **Media UI redesign 🚧 code complete, needs verify.** Rebuilt `/media` to match
  `docs/Design/Media Library Dashboard Mockup.png`: `HeroHeader` + Upload Image,
  three stat cards (Total Images / Assets Using Images / Total Size via
  `getMediaStats`), toolbar with search + **All Types** filter + **Most Used/Recent**
  sort + grid/list view toggle, richer cards (used-by pill, type·size, ⋯ Edit/Delete
  menu) linking to a new **media detail page** `/media/[id]` (large preview, Details
  incl. dimensions/uploaded/by, "Used in Assets" list, Notes) with
  `media-detail-actions.tsx` (edit dialog + delete). Backend: `listMedia` gained
  type filter + sort + offset pagination (join+groupBy so "most used" sorts by
  count), `getMediaStats`, `getMediaDetail`; `GET /api/media` takes `type`/`sort`/
  `offset` → `nextOffset`. Replacing a shared file is intentionally out of scope
  (would change every asset using it). **Next: restart dev, walk `/media` + detail;
  `npm test`; commit.**
- **Phase 2 (image resizing, sharp) ✅ committed (`feat/media-resizing`).** On upload:
  cap the stored original to 2000px, bake EXIF orientation, record real `width`/
  `height`, generate a 400px WebP `thumbnail` (`web/src/lib/image.ts`), stored as a
  second object. Lists/table/picker render the thumbnail; dedup unchanged. Phase 3
  (rembg cut-out worker) 🔜.
- **Phase 1 (reuse core + library) ✅ built, backfilled, verified; `imageKey` dropped.**
  Reuse confirmed end to end (one upload used by two printers, counted correctly).
  Upload names default to the device **model**; `imageId` replaces `imageKey` (column
  dropped after backfill). Vitest green. One-time `backfill-media.ts`/`diag-media.ts`
  removed after use. Pending: commit + spec-18 follow-ups (scope enroll, AGENTS sync,
  note 17.02 superseded). Phases 2 (sharp resizing) / 3 (rembg cut-out worker) 🔜.
  - Schema: new `media` table (+ partial-unique `media_sha256_uq`), `assets.imageId`
    (FK→media, `restrict`); `assets.imageKey` kept temporarily, dropped after backfill.
  - Data layer `web/src/db/media.ts` (create-or-reuse-by-hash with 23505 dedup-race
    handling, list+usage, update, delete-unused with 23503→in-use); `asset-images.ts`
    reworked onto `imageId`.
  - API: `GET/POST /api/media`, `GET/PATCH/DELETE /api/media/[id]`, shared
    `web/src/lib/media-serve.ts`; `GET /api/assets/[tag]/image` reworked to resolve
    through media (POST/DELETE removed); `setAssetImage` server action
    (`web/src/app/(app)/media-actions.ts`).
  - UI: `/media` page + `media-library.tsx` (grid/search/upload/edit/delete),
    `media-picker-dialog.tsx`, asset photo control reworked (Upload new / Choose from
    library / Remove), `AssetImage` serves via `imageId`; Media nav entry.
  - Tests: `media.test.ts` (dedup race, delete guard, usage count, classifiers),
    asset-image `route.test.ts` rewritten for GET-only.

---

## Previously in progress 🚧 — spec 17 UI redesign (branch `feat/printers-ui-redesign`)

Umbrella program (spec 17, `docs/specs/17-ui-redesign/`): light-first + blue design
system, asset image upload, then rebuild printers / computers / thin categories.
Scope tracker: `docs/scope/scope.md` → "OPUS UI redesign". Build children in order.

- **Child 01 (design system) ✅ built, verified, tested, committed.** Blue tokens +
  light default (`globals.css`, `layout.tsx`), light sidebar with blue active item,
  `HeroHeader` + `Tabs` primitives, teal-literal guard (`scripts/check-no-teal.mjs` +
  `no-teal-literal.test.ts`), design doc rewritten. `/check verify` walked every page
  in light (pass); `/test` green. `HeroHeader`/`Tabs` are built but only mounted in
  child 03. Hero photo staged at `web/public/heroes/printers.png`.
- **Child 02 (asset image upload) 🚧 code complete + tested, NOT committed, NOT verified.**
  Decision changed mid-flight: **MinIO is archived (Feb 2026), so it is fully removed**
  from all specs; storage is now `@aws-sdk/client-s3` (installed, `forcePathStyle`)
  against a self-hosted S3-compatible store. Code: `assets.image_key` column (schema),
  `web/src/lib/storage.ts`, `web/src/db/asset-images.ts`, route
  `web/src/app/api/assets/[tag]/image/route.ts` (GET/POST/DELETE), UI
  `asset-image.tsx` + `asset-image-upload.tsx` wired into `asset-detail.tsx` +
  `asset-table.tsx`. Tests: `route.test.ts` + `storage.test.ts` (20 pass). `tsc` clean.

  **Resume child 02 here (in order):**
  1. Start Docker Desktop (installed at `C:\Program Files\Docker\Docker`; the engine
     was not running, which made `docker` commands hang — wait for "Engine running").
  2. `cd dev/seaweedfs && docker compose up -d` (local dev S3 store, SeaweedFS on
     `:8333`; creds in `dev/seaweedfs/s3.json` = `opusdev` / `opusdevsecret123`).
  3. Add to `web/.env`: `S3_ENDPOINT=http://localhost:8333`, `S3_REGION=us-east-1`,
     `S3_ACCESS_KEY_ID=opusdev`, `S3_SECRET_ACCESS_KEY=opusdevsecret123`,
     `S3_BUCKET=opus-assets` (bucket auto-created on first upload).
  4. `cd web && npm run db:push` to apply the `image_key` column.
  5. Restart the web dev server, upload a photo on an asset detail page, then
     `/check verify opus ui redesign`.
  6. Commit child 02 (code + tests + the MinIO-removal spec edits + `dev/seaweedfs/`).
- **Children 03 (printers) / 04 (computers) / 05 (thin categories) 🔜** — not started.

---

## Shipped

### Pipeline — end to end ✅ (2026-08-26)
Scan the fleet → authenticate as a service account → ingest → reconcile → live in the UI.

| Phase | Branch | What shipped |
|---|---|---|
| Collector ingest + live drawer | `feat/collector-ingest` | Collector `--ingest` posts runs (client-credentials token → `/api/ingest/scan`); detail drawer shows **real** OS/CPU/RAM/disk/uptime for matched assets |
| Ingest API | `feat/ingest-api` | `machines` table; `POST /api/ingest/scan` (verifies service token via JWKS + `ingest:write` scope), upsert + reconcile to assets by serial (matched vs discovered); `/api` excluded from auth proxy |
| Service accounts | `feat/auth-service-accounts` | `ServiceAccount` model, `POST /v1/auth/token/client` (client-credentials → RS256 service token w/ scopes), `create_service_account` CLI, admin |
| Production serving | `feat/auth-serving` | granian (WSGI) + WhiteNoise for static/admin; fixed logout to `AllowAny` (blacklists refresh token) |
| Inventory DB | `feat/inventory-db` | Drizzle + Postgres (`aw_it_inventory`); DB-backed dashboard/table/drawer/⌘K; `/api/assets`; seed; `db:push`/`db:seed`/`db:studio` |

### Collector ✅
| Phase | Branch | What shipped |
|---|---|---|
| Specific targets | `feat/collector-targets` | `--target` (repeatable/comma-separated IP or CIDR) + `--targets-file` |
| Agentless scanner | `feat/collector` | Python/uv: TCP-probe discovery + classify, credential resolution (subnet rules + fallback), WinRM/PowerShell hardware+health, SNMP printers, JSON run reports |

### Auth (`aw-auth`) ✅
| Phase | Branch | What shipped |
|---|---|---|
| Name claim | `feat/auth-name-claim` | `name` claim in tokens; `full_name` required for superusers; Base UI dropdown-group fix |
| Local verification | `feat/web-jwks-verify` | Web verifies tokens locally via `jose` + JWKS (no `/me` per request; `/me` fallback) |
| Web login | `feat/web-auth` | `/login`, httpOnly cookies, proxy token refresh, real user in top bar, RBAC-gated nav |
| RS256 + JWKS | `feat/auth-jwks` | RS256 signing, `generate_keys`, `/.well-known/jwks.json` + OIDC discovery, `kid` on tokens |
| Auth core | `feat/auth-service` | Standalone Django + DRF: email User (Argon2), RBAC (roles/permissions), register/login/refresh/logout/me, admin, OpenAPI |

### Web UI ✅
| Phase | Branch | What shipped |
|---|---|---|
| Add/edit/delete asset form | `feat/add-edit-asset-form` | Manual asset CRUD from the UI: one `AssetFormDialog` (create + edit) off a "New asset" button on the dashboard and all five category pages (type pre-filled) and Edit on `/assets/[id]`; `createAsset`/`updateAsset`/`deleteAsset` Server Actions gated on `asset:write`; one shared zod schema on client + server; `generateTag`/`TAG_PREFIX` shared with ingest; guarded in-app delete (machine returns to inbox); Vitest coverage |
| Category list views | `feat/category-list-views` | Real per-type tables (Computers/Monitors/Printers/Phones/Network) on one config-driven `AssetTable`; dedicated `/assets/[id]` detail page replaces the side drawer (`?asset=` retired); `asset:read`-gated; Vitest + Testing Library suite |
| Discovered-devices inbox | `feat/discovered-devices-inbox` | `/scans` inbox: lists unmatched machines with up-to-3 ranked asset suggestions; link / quick-create / ignore / restore via `asset:write`-gated Server Actions; one nullable `machines.ignoredAt` column (ignore survives re-scans) |
| Asset detail | `feat/asset-detail` | URL-driven side drawer (metadata, health, audit, actions); clickable rows + ⌘K deep-link |
| Dashboard | `feat/ui-dashboard` | Next.js + Tailwind v4 + shadcn (Nova); sidebar/top bar, ⌘K palette, theme toggle, KPI cards, TanStack table, charts |

### Specs & design ✅
- `docs/specs/` — plan, architecture, auth spec, data model, collector spec, frontend spec.
- `docs/Design/` — OPUS design system + interactive mockup (`opus-dashboard.html`).

---

## Next / backlog 🔜

**Closed (won't do):** Spec 33 portal/create-from-mail/attachments; Spec 31 v2 WSUS /
WUA approve-hide / further patch orchestration.

### Strong candidates (pick one)

- **NSSM / prod service packaging** — web + aw-auth + collector worker as Windows
  services (the real on-prem deploy step).
- **Software deploy polish (slice 2–3)** — package templates (e.g. Wise ePad) and
  break-glass export; slice 1 (skip-if + timeouts) on `feat/software-deploy-polish`.
- **Spec 34 deepen** — more assist surfaces (script explain, ticket reply draft)
  only where technicians already work.
- **License / warranty expiry** — track and alert on software licenses + asset
  warranty dates (inventory already has some warranty hooks).
- **Metric / report polish** — Spec 26/29 improvements (saved fleet health views,
  alert→report links) without new PSA/patch epics.

### Web app — stubs (niche)

- **Scan QR** 🔜 — asset-table button toasts "coming later".
- **Print label** 🔜 — detail-page button toasts "coming later".

### Collector / infra

- **WMI-over-DCOM fallback** — scan hosts that only expose SMB (no WinRM).
- **NSSM service wrappers** — see strong candidates above.

### aw-auth (not web-focused)

- **MFA (TOTP)**, **refresh-token reuse detection UI**, **DRF service-account CRUD**.

### Done since this list was written

- ~~Schedule the collector~~ ✅ — printer reachability schedule (spec 12) + scheduled
  computer sweep (`feat/scheduled-computer-sweep`).
- ~~Reports page~~ ✅ (`feat/reports-page`) · ~~Export CSV~~ ✅ (`feat/csv-export`) ·
  ~~Notifications~~ ✅ (spec 19, `feat/notifications`) · ~~Remote printer install~~ ✅
  (spec 20) · ~~In-app user management~~ ✅ (PR #52) · ~~Dashboard redesign~~ ✅ (PR #51).
- ~~`printer-detail.tsx` → `detail-ui`~~ ✅ · ~~Ingest orphan cleanup~~ ✅
  (`fix/ingest-orphan-cleanup`).
- ~~Collector: report all profile failures~~ ✅ (`collect_windows` lists every
  profile's per-profile reason; see the top of this log).
- ~~Compliance page~~ ✅ — shipped as **spec 21** (posture collect + health score +
  per-device tab + fleet dashboard); see the top of this log. No longer blocked.
- ~~Cancel a stuck install job~~ ✅ (`feat/cancel-install-job`).
