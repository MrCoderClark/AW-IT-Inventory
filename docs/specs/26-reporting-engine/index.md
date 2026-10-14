# Spec 26 — Reporting engine

## Problem

`/reports` is four hardcoded aggregates (warranty, aging, assignments, software).
When management asks for "all Dell laptops out of warranty in the Bronx assigned to
Finance", there's no way to produce it without a code change. OPUS needs a **custom
report builder**: pick a data source, choose columns, filter/group/sort, run,
export, and save the definition to re-run later.

## Principles

- **No user SQL, ever.** The builder only composes queries from a whitelisted
  **field catalog** per data source. Values are parameters; field/operator choices
  are validated against the catalog server-side.
- **Denormalized data sources.** Each source is a server query returning flat rows
  with known field ids. The fleet is ~hundreds of rows, so v1 filters/groups/sorts
  **in memory** from the source's base query (one readable pure function); SQL
  push-down is a later scale optimization.
- **Saved definitions are data.** A report is a `{source, columns, filters,
  groupBy, aggregates, sort, limit}` spec stored as jsonb — portable, re-runnable,
  shareable.

## Phase 1 (this spec)

Six data sources, on-demand run + live preview, CSV/Excel/PDF export, and saved
report definitions. Scheduling + email delivery is **phase 2**.

### Data sources (field catalog)

| Source | Rows | Highlights |
|---|---|---|
| `assets` | every asset | type, status, serial, model, vendor, location, assignee, purchase/warranty, cost center |
| `computers` | Computer assets | + CPU/RAM/OS/storage/form-factor/IP + compliance score & per-check verdicts + at-risk |
| `assignments` | custody records | person (name/dept/title), device (tag/name/type), assigned/returned, duration, current vs returned |
| `people` | directory | dept, title, email, employee id, status, office location, device count |
| `software` | tracked installs | tracked title, program, version, publisher, arch, machine (tag/name/location) |
| `printers` | Printer assets | model, vendor, location, IP, total pages, reachability, consecutive failures |

### Query spec

`ReportSpec = { source, columns[], filters[], groupBy[], aggregates[], sort[], limit }`.
Filters are ANDed in v1. Operators are **type-aware** (text: contains/eq/empty;
number/date: eq/gt/lt/between; enum: in; bool: is). When `groupBy` is set the result
is the group keys plus the chosen `aggregates` (count/sum/avg/min/max); otherwise the
selected `columns`. `runReport(rows, spec, fields)` is a pure, unit-tested function.

### Storage & RBAC

- `report_definitions` (id, name, description, source, spec jsonb, createdBy, shared,
  timestamps). Needs `db:push`.
- **`report:read`** (exists) to view + run reports; **`report:write`** (new — aw-auth
  `seed_rbac` + reseed) to create/edit/delete shared report definitions.

### Export

Client-side from the already-loaded result set, lazy-loaded on click: **CSV**
(existing helper), **Excel** (`exceljs`), **PDF** (`jspdf` + `jspdf-autotable`).

### Surfaces

`/reports` becomes a hub — **Standard reports** (the current four) + **Custom
reports** (saved list) + **New report** → `/reports/builder` (source → columns →
filters → group/sort → live preview → save). A saved report opens at
`/reports/custom/[id]`.

## Build order / status

- **1a engine — ✅ DONE** (field catalog + 6 source queries + `runReport` + `report_definitions` + db module + tests + `report:write`). On branch `feat/spec-26-reporting`, committed `890d96f`.
- **1b builder UI — ✅ DONE** (`/reports/builder`: source → columns → type-aware
  filters → group/aggregate → sort/limit → debounced live preview; create+edit;
  `report:read` to run, `report:write` to save). Server actions
  `src/app/(app)/reports/report-actions.ts` (`runReportAction` / `saveReportAction`
  / `deleteReportAction`, each gated + `validateSpec`'d); component
  `src/components/report-builder.tsx`; a "New custom report" button on `/reports`.
- **1c exports — ✅ DONE** (client-side CSV/Excel/PDF from the loaded result set).
  `src/lib/report-export.ts` (pure `reportToCsv` + `exportCsv`/`exportExcel`/
  `exportPdf`, the office libs **dynamically imported** so they chunk-split and
  load only on first export); `src/components/report-export-menu.tsx` (an Export
  dropdown that re-runs the full spec via `runReportAction` — not the capped
  preview — then downloads). Deps: `exceljs`, `jspdf@3`, `jspdf-autotable@5`.
- **1d saved-reports hub — ✅ DONE** (`/reports` gains a "Custom reports" tab listing
  saved definitions — open/edit/delete, gated on `report:write` for edit+delete;
  `src/components/custom-reports-list.tsx`. `/reports/custom/[id]` runs a saved report
  live with the shared `ReportResultTable` + the export menu + Edit. Shared table
  extracted to `src/components/report-result-table.tsx`, used by builder + saved page.)

**Phase 1 COMPLETE** (1a–1d). 717 web tests pass, type + lint clean.

Deploy prerequisites (once): `npm run db:push` (report_definitions) + aw-auth
`seed_rbac` (+ admin re-login for `report:write` — perms ride the JWT) + `npm install`
(exceljs / jspdf / jspdf-autotable). Engine entry points: `runReportBySpec(spec)` and the
CRUD in `src/db/report-engine.ts`; catalog in `src/lib/report-sources.ts`.

## Phase 2 — scheduled delivery (on branch `feat/spec-26-reporting-phase2`)

The headline feature: a saved report emailed to recipients on a cadence, reusing
the aw-auth notify path + the worker scheduler (the spec 19 warranty-sweep model —
schedules are **data in web**, the worker just fires a periodic trigger).

- **2a schedule model + UI — ✅ DONE.** `report_schedules` table (one per report:
  cadence daily/weekly/monthly + time, weekday/day-of-month, recipients, format
  csv|xlsx, enabled, lastRunAt/nextRunAt). Pure core `src/lib/report-schedule.ts`
  (`computeNextRun` / `describeSchedule` / `validateScheduleInput`, unit-tested);
  server data `src/db/report-schedules.ts` (upsert/get/delete + `listDueSchedules`
  / `advanceSchedule` ready for 2b); actions `saveScheduleAction` /
  `deleteScheduleAction` (`report:write`); `src/components/schedule-dialog.tsx` on
  the saved-report page + schedule badges on the hub. **Needs `db:push`.**
- **2b delivery engine + email — ✅ DONE.** Web `deliverDueReports()`
  (`src/db/report-delivery.ts`) + `POST /api/scan/reports/deliver` (service
  `scan:dequeue`, `runtime=nodejs` for exceljs): finds due schedules, runs each,
  builds a capped preview table + full CSV/Excel attachment
  (`src/lib/report-attachment.ts`), emails via `sendReportEmail()` (`notify.ts`) →
  **new aw-auth `/v1/notify/report`** (`ReportDeliveryView` + `send_report` +
  `_report_html`; `_deliver` generalized to take explicit recipients + Resend
  attachments), then `advanceSchedule`. Advance rules: sent → advance; transient
  send failure → leave pending (retry); report that throws → advance anyway.
  Keyed on `sent`. Tests: web `report-delivery.test.ts`, aw-auth
  `ReportDeliveryResendTest`.
- **2c worker cadence — 🔜 NEXT.** `report_delivery` trigger in collector
  `reachability.py` + a scheduler job in `worker.py` (near-copy of
  `warranty_sweep_job`), on a configurable cadence hitting the 2b endpoint.

Later Phase 2 extras (each its own effort): report folders/categories, SQL
push-down for scale, charts in reports.
