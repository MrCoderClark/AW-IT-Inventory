# Computer audit log — unified action history + reporting

**Date**: 2026-10-23  
**Status**: Accepted (design)  
**Parent**: [Overview](../../specs/00-overview-and-plan.md) (aspirational “audit log for every mutating action”); reporting via [Spec 26](../../specs/26-reporting-engine/index.md)  
**Related**: Per-feature job tables (deploy, patch, reboot, scripts, remote, assignments); unused `audit:read` in aw-auth RBAC  
**UI mock**: [`docs/Design/computer-audit-log-mock.png`](../../Design/computer-audit-log-mock.png)  
**Branch**: `docs/spec-computer-audit-log` (spec); implementation on a later `feat/…` branch

## Goal

Give admins a **single fleet-wide Audit log** of actions taken against **computers**, with **action-specific details** (e.g. installed package name; app update previous → new version), Status Pending/Success/Failed, and the ability to **report on the same stream** in the existing Reports builder.

## Locked decisions

| Topic | Choice |
|---|---|
| What to log | **Admin/operator actions + automated/scheduled jobs** that touch a computer (not routine scans/metrics polls) |
| Assets | **Computers only** in v1 |
| Row lifecycle | **One row per job** — starts `pending`, updates to terminal (`succeeded` / `failed` / `canceled`) |
| History | **Forward-only** from ship day (no backfill of old job tables) |
| Architecture | **Dual-write** `computer_audit_events` from existing enqueue/terminal paths |
| Permission | Existing **`audit:read`** for `/audit` and the report source |
| Reporting | New Spec 26 source **`computerAuditEvents`** |
| Export on `/audit` | **CSV** in v1; PDF via Spec 26 report export (no separate PDF button required in v1) |

## Out of scope (explicit)

- Printers / monitors / phones / thin assets  
- Collector scan jobs and metrics polling noise  
- aw-auth login / role-change security audit  
- Historical backfill from existing job tables  
- Union-view over job tables (no dual-write)  
- Event bus / Trigger.dev / Inngest  
- Editing or deleting audit rows from the UI  
- Retention/prune policy (revisit if table growth hurts)  
- Merging into per-asset Activity tab (optional follow-up)  
- Manual “flag” UI (KPI may stay at 0, or auto-flag `failed` later)

## Approach (chosen)

**Dual-write `computer_audit_events`.** Small helpers upsert on enqueue and update on terminal. Unique `(source_table, source_id)` ties each row to the originating job. `/audit` and Spec 26 both read this table.

Rejected alternatives: live UNION of job tables (weak details / hard filters); separate durable workflow product (duplicates collector queues).

---

## §1 Data model

**Table:** `computer_audit_events` (web DB / Drizzle)

| Column | Type / notes |
|---|---|
| `id` | UUID PK |
| `occurred_at` | timestamptz — set at enqueue; **stable** when status updates |
| `asset_id` | UUID FK → `assets` (computer) |
| `action` | text enum (stable codes below) |
| `status` | `pending` \| `succeeded` \| `failed` \| `canceled` |
| `operator` | text — actor email, or `system` / schedule label |
| `source` | `admin_console` \| `scheduled` \| `collector` (UI labels: Admin Console / Automated Policy Engine / Collector) |
| `summary` | text — short Details column line |
| `details` | jsonb — structured fields (`packageName`, `fromVersion`, `toVersion`, `kbIds`, `scriptName`, …) |
| `source_table` | text — e.g. `software_deployments`, `patch_install_jobs` |
| `source_id` | UUID — originating row id |
| `flagged` | boolean default false |
| `updated_at` | timestamptz — last status/detail refresh |

**Unique:** `(source_table, source_id)`.

**Indexes:** `(occurred_at DESC)`, `(asset_id, occurred_at DESC)`, `(action)`, `(operator)`, `(flagged)` where useful for filters/KPIs.

### Action codes (v1)

| Code | Typical summary |
|---|---|
| `software_deploy` | `Installed {name} {version}` |
| `app_upgrade` | `Updated {name} {fromVersion} → {toVersion}` |
| `os_patch_install` | OS KBs / count + outcome |
| `missing_update_check` | Checked for updates (+ missing count when known) |
| `reboot` | Forced reboot (one-shot / after install) |
| `reboot_schedule` | Recurring schedule create/update/disable/delete or materialized occurrence (see instrumentation) |
| `script_run` | Script name + outcome |
| `remote_session` | Remote session opened/ended (single row updated) |
| `assignment_change` | Assignee before → after |
| `asset_update` | Computer field changes summary |

Exact mapping of reboot-schedule lifecycle (one row for the schedule edit vs per occurrence) is resolved in the implementation plan; occurrences that are `reboot_jobs` already emit `reboot` with `source=scheduled`.

### Write helpers

- `upsertAuditEvent({ sourceTable, sourceId, assetId, action, operator, source, summary, details, status })`
- `updateAuditEventStatus({ sourceTable, sourceId, status, summary?, details? })`

**Failure policy:** audit helper errors are logged; they **must not** fail the primary job transaction when avoidable (best-effort after the job write succeeds, or catch-and-log).

---

## §2 UI

**Route:** `/audit`  
**Nav:** Manage group (alongside Reports / Scans).  
**Gate:** `audit:read`.

**Chrome (mock):** HeroHeader “Audit log” + Activity badge; **Export CSV**.

**Filters:** Asset · Action · Operator · Time range (default **last 30 days**) · Location (via asset location).

**KPI strip:** Total events · Actions today · Unique operators · Flagged.

**Table:** Time · Asset (link `/assets/{tag}`) · Serial · Action (chip) · Operator · Source · Status · Details (`summary`).

**Row detail:** Expand or side drawer with key/value rendering of `details` (versions, package id, KBs, etc.).

**Not in v1 UI:** PDF export button on this page; flag toggle; edit/delete.

---

## §3 Instrumentation + reporting

### Hook points

On **enqueue** (or equivalent create): insert/upsert row `status=pending`.  
On **terminal** (succeeded / failed / canceled): update status and enrich `summary` / `details`.

v1 surfaces to wire (non-exhaustive; plan lists files):

- Software deploy / app upgrade jobs  
- Patch install + missing-update check  
- Reboot jobs (+ schedule admin actions as needed)  
- Script runs (incl. scheduled)  
- Remote sessions  
- Assignment changes  
- Computer asset field updates (meaningful mutations only)

Scheduled/automated work: `source=scheduled` (or `collector` when the worker itself initiates without a user), `operator=system` or a stable schedule label.

### Spec 26

Register source **`computerAuditEvents`** in `report-sources.ts` + fetcher in `report-engine.ts` (and pushdown filters if cheap). Columns aligned with the audit table / list DTO so custom reports, schedules, and CSV/Excel/PDF export work like other sources.

`/audit` CSV export may reuse the same list/query helper as the report fetcher.

### Permissions

- Page + API/list: `audit:read`  
- Report source: same gate when running/exporting that source  
- Writers: no new permission — side effect of existing mutating permissions (`software:deploy`, etc.)

---

## Acceptance criteria (design-level)

1. After ship, enqueueing a software deploy for a computer creates a Pending audit row; on success, Details/summary name the package (and version when known).  
2. An app upgrade terminal event shows previous and new version in summary and/or details.  
3. A scheduled reboot occurrence appears with Source reflecting automation and Status updating to terminal.  
4. `/audit` is filterable and exportable as CSV for `audit:read` users.  
5. Spec 26 builder can select **Computer audit events** and produce a report/export over the same data.  
6. Audit write failure does not block the underlying job from completing.

## Open follow-ups (not blocking v1)

- Auto-flag failed events for the Flagged KPI  
- Per-computer Activity tab merge  
- Printers and other asset types  
- Optional backfill tool  
- PDF button on `/audit` if product wants parity with the mock without going through Reports  

## Self-review notes

- No placeholders left for locked choices.  
- Scope explicitly excludes scan noise and auth audit to avoid volume/confusion.  
- Dual-write risk (forgotten call sites) is accepted; plan should include a checklist of enqueue/terminal paths and a regression note for new job types.
