# OPUS scope

The living, coarse scope for OPUS. Each feature is a milestone rollup, not a task
dump: the atomic build steps stay in each feature's spec (`docs/specs/`). Run
`/scope` to reconcile this against what has shipped and to enroll the next slice.

> This file was seeded by `/architect` when spec 11 was captured. Specs 00 to 10
> predate it and are tracked directly by their own specs; `/scope` will backfill
> them on its next reconcile if wanted.

## At a glance

| Feature | Status | Spec |
|---|---|---|
| Global table column configuration | done | [11](../specs/11-table-column-config/index.md) |
| Scheduled and manual scans | in-progress | [12](../specs/12-scheduled-manual-scans/index.md) |
| Discovery type toggles | in-progress | [13](../specs/13-discovery-type-toggles/index.md) |

## Features

### Global table column configuration · done

Let admins choose which columns each asset table shows, and in what order, saved
once and seen by everyone, across the five category pages, the dashboard, and the
location device pages.

**Done when**: an admin with `columns:write` can add, remove, and reorder columns
on any of the seven views from a toolbar picker; the choice is saved globally and
every user sees it; a view with no saved layout renders exactly today's columns.

- [x] Design it (spec): [11](../specs/11-table-column-config/index.md)
- [x] Build it: `/develop table column config` — code in `web/src/lib/table-columns.ts`,
      `web/src/components/{asset-table,column-picker-dialog}.tsx`,
      `web/src/app/(app)/columns-actions.ts`, `web/src/db/{schema,queries}.ts`,
      `aw-auth/rbac/management/commands/seed_rbac.py`
  - [x] Foundations: the `table_column_config` table and enum, and the
        `columns:write` permission in the aw-auth seed (covers AC-1, AC-8)
        — `db:push` and `seed_rbac` applied; confirmed live in `/check verify`
        (pages read the table, saves persist, the permission gates the picker
        after re-login).
  - [x] Column engine: stable column ids, the code-owned catalog and defaults, and
        the `AssetTable` render rule (saved list over defaults) (covers AC-2, AC-3,
        AC-6)
  - [x] Read + write path: `getColumnConfig`, the gated save and reset actions, and
        one view wired end to end (covers AC-2, AC-5, AC-6)
  - [x] Picker UI: the "Columns" toolbar button and dialog (toggle, reorder, save,
        reset), shown only to `columns:write` admins (covers AC-4, AC-5)
  - [x] Widen: the remaining six views plus a regression pass over search, filters,
        sorting, pagination, and row-click (covers AC-2, AC-7)
- [x] Verify it: `/check verify table column config`
- [x] Test it: `/test table column config` — 50 tests in `table-columns.test.ts`,
      `columns-actions.test.ts`, `column-picker-dialog.test.tsx` (full suite: 171 pass)

### Scheduled and manual scans · in-progress

Let admins start an on-demand scan of one computer, several selected computers, or every
known device from the UI, and have the collector ping every printer three times a day to
track reachability, flagging a down printer in the UI and emailing the admins. Built on
one long-running collector worker (a DB job queue it polls, plus an in-process scheduler);
alerts are sent by aw-auth via Resend.

**Done when**: an admin with `scan:write` can trigger a manual scan (single, selected, or
all) that the worker runs and reconciles; every manually-entered printer is checked 3×/day
(default 08:00/13:00/18:00, full SNMP once daily); a printer down for 2 checks in a row is
flagged in the UI and triggers one admin email, with one email on recovery; reachability
history and status are visible on the printers views.

- [x] Design it (spec): [12](../specs/12-scheduled-manual-scans/index.md)
- [ ] Build it: `/develop scheduled and manual scans` — milestones 1–2 code in
      `web/src/db/{schema,scan}.ts`, `web/src/app/api/scan/{claim,jobs/[id]/status}/route.ts`,
      `web/src/app/(app)/scan-actions.ts`, `web/src/components/{asset-detail,asset-table,scan-jobs-view}.tsx`,
      `web/src/app/(app)/scans/jobs/page.tsx`, `collector/{worker,main,config}.py`,
      `aw-auth/accounts/management/commands/set_service_account_scopes.py`.
      Milestones 3–4 (reachability, alerting, printer UI, retention) not started.
      Also added a manual `ipAddress` field to computers (schema `computer_details`,
      `web/src/lib/{asset-fields,table-columns}.ts`, `web/src/db/queries.ts`) so any
      computer can be scan-targeted, not only collector-discovered ones — extends
      spec 10's computer form; `/sync` should reconcile it into specs 10/12.
  - [ ] Foundations: the four web tables (`scan_jobs` + partial pending index,
        `printer_checks`, `printer_status`, `scan_workers`), the collector service account
        granted `scan:dequeue`, and a new `opus-web` service account with `notify:send`
        (covers AC-1, AC-9) — schema + service-account tooling written; awaiting the
        engineer's `db:push` + service-account commands to confirm live.
  - [ ] Manual scans end to end: the `main.py worker` loop, the claim/status endpoints
        (atomic claim + claim fence), `requestScan`/`cancelScanJob`, the Scan now /
        selected / all controls, the jobs view, and the stuck-job reaper
        (covers AC-1, AC-2, AC-3, AC-4, AC-5) — code complete; awaiting typecheck + verify.
  - [ ] Printer reachability + alerting: the APScheduler checks (TCP probe + daily SNMP),
        the reachability endpoint writing `printer_checks`/`printer_status`, and aw-auth's
        notify endpoint sending down/recovery email via Resend to admins (covers AC-6, AC-7)
  - [ ] Printer UI + retention: reachability badge and recent history on the printers
        views, plus the daily history prune (covers AC-8, AC-10)
- [ ] Verify it: `/check verify scheduled and manual scans`
- [ ] Test it: `/test scheduled and manual scans`

### Discovery type toggles · in-progress

Give admins per-type on/off switches for what the collector automatically discovers
(Computers, Printers), controlled from the web Admin page, persisted in the web DB, and
read by the collector before each automatic sweep. Manual scans bypass the switches;
turning Printers off also pauses the spec-12 scheduled reachability checks.

**Done when**: an admin with `scan:write` can turn Computers or Printers on/off on the
Admin page; the collector's `scan` sweep skips an off type (never collected, ingested, or
shown in the inbox) while manual scans still run; the collector falls back to a local cache
(then all-on) when it can't read the settings; and both-off is allowed (auto-scan discovers
nothing, logs a warning).

- [x] Design it (spec): [13](../specs/13-discovery-type-toggles/index.md)
- [ ] Build it: `/develop discovery type toggles` — code in
      `web/src/db/{schema,discovery}.ts`, `web/src/app/api/scan/discovery-settings/route.ts`,
      `web/src/app/(app)/{admin/page,discovery-actions}.ts(x)`,
      `web/src/components/{discovery-toggles,ui/switch}.tsx`,
      `collector/{ingest,config,main,worker}.py`. Milestones 1 and 2 are built and
      verified live (`db:push` applied, table confirmed). Milestone 3 (reachability
      link) is the only open item, deferred to spec 12 milestone 3.
  - [x] Foundations + collector read: the `discovery_settings` table and read/upsert
        helpers, `GET /api/scan/discovery-settings` (service `scan:dequeue`), and the
        collector fetching + caching + applying it via `no_windows`/`no_printers` (manual
        jobs bypass) (covers AC-1 data, AC-2, AC-3, AC-4, AC-6, AC-7 endpoint, AC-8)
        — built and verified: endpoint live, table live, collector run confirmed it skips
        an off type and a manual scan still runs.
  - [x] Admin UI: the Discovery switches on `/admin` and the `setDiscoveryToggleAction`
        server action gated on `scan:write`, hidden/read-only without it (covers AC-1, AC-7)
        — built and verified: toggle persisted round-trip in the live app.
  - [ ] Reachability link: gate the spec-12 scheduled reachability run on the Printers
        switch (when that scheduler exists) (covers AC-5) — deferred: spec 12 milestone 3
        (the reachability scheduler) is not built yet, so the gate lands with it.
- [x] Verify it: `/check verify discovery type toggles` — web, endpoint, and the admin
      toggle verified live by Claude; the collector sweep (AC-3 skip, AC-4 bypass, AC-8)
      confirmed by the engineer's own run. AC-5 deferred until spec 12 milestone 3.
- [x] Test it: `/test discovery type toggles` — 16 web tests (`web/src/db/discovery.test.ts`,
      `discovery-actions.test.ts`, `discovery-settings/route.test.ts`, `discovery-toggles.test.tsx`)
      plus 6 collector smoke tests (`collector/tests/test_discovery.py`), all pass. Covers the
      automatable ACs (1, 2, 3 endpoint, 6, 7); AC-4 and AC-8 (a real sweep) stay for runtime verify.
