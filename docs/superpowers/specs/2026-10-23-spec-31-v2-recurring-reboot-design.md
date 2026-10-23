# Spec 31 v2 — Recurring reboot (per-computer daily / weekly)

**Date**: 2026-10-23  
**Status**: Accepted (design)  
**Parent**: [Spec 31 patch management](../../specs/31-patch-management/index.md)  
**Related**: [Scheduled reboot (one-shot)](./2026-10-22-spec-31-v2-scheduled-reboot-design.md)  
**Branch**: `docs/spec-31-v2-recurring-reboot-design` (spec); implementation on a later `feat/…` branch

## Goal

Let an admin with `software:deploy` define **one recurring forced-reboot
schedule per computer** (daily or weekly at a chosen local time). The existing
one-shot `reboot_jobs` queue and collector WinRM path stay the execution engine;
recurrence only **materializes** the next pending job.

## Locked decisions

| Topic | Choice |
|---|---|
| Scope | **Per-computer only** (Updates tab); no fleet multi-select in this slice |
| Cadence | **Daily** and **weekly** (one or more weekdays + time) |
| Missed window | **Skip** — never catch-up ASAP after an outage |
| Cardinality | **At most one** enabled schedule per computer |
| Architecture | **Schedule row + materialize next one-shot** `reboot_jobs` |
| Timezone | Persist **IANA timezone** + local `HH:MM` from the browser at save |
| One-shot coexistence | Soft one-in-flight remains; if a schedule already has a pending child, one-shot enqueue **rejects** with a clear error |
| Cancel occurrence | Cancels that `reboot_jobs` row only; series stays enabled; materializer books the next future slot |
| Disable / delete | Disable or delete cancels any pending child for that schedule |
| Permission | `software:deploy` (same as one-shot) |
| Install-linked recurrence | **Out of scope** (one-shot install-linked reboot unchanged) |

## Out of scope (explicit)

- Fleet / tag-wide recurring reboot  
- Catch-up after missed windows  
- Multiple concurrent schedules per computer  
- Cron / “every N days”  
- Desktop countdown / user warning  
- Recurring reboot tied to patch-install  
- WSUS / portal  

## Behavior

### Create / edit

1. Admin opens Computer **Updates**.  
2. Under **Recurring reboot**, chooses Daily or Weekly; for weekly, selects
   weekday(s); sets time of day. UI shows a **next run** preview in local time.  
3. Save upserts the single `reboot_schedules` row for that asset (replace
   semantics). Browser timezone (`Intl` IANA) and `HH:MM` are stored.  
4. Materializer immediately inserts the next future pending `reboot_jobs` child
   (if none already in-flight for this schedule / asset rules below).

### Disable / delete / edit mid-flight

- **Disable**: `enabled = false`; cancel pending child if any.  
- **Delete**: remove schedule row; cancel pending child if any.  
- **Edit** cadence/time/weekdays: cancel pending child; recompute and enqueue
  the next future occurrence.

### Runtime

1. Collector claims due `reboot_jobs` exactly as today (`scheduledAt <= now`,
   forced WinRM reboot).  
2. When a schedule-sourced job reaches **succeeded**, **failed**, or
   **canceled**, materializer enqueues the **next** future occurrence (skip
   any slot already in the past).  
3. Periodic materialize pass (web-side, ~1 minute) covers enable-with-no-child
   and recovery if a terminal transition missed a hook.

### One-shot interaction

- One-shot **Schedule reboot** remains.  
- If this asset already has a **pending / claimed / running** reboot job
  (including a schedule child), one-shot enqueue fails with a clear conflict
  error (existing soft one-in-flight).  
- Materializer does not create a second pending job while any reboot is
  in-flight for the asset.

## Data model

```
reboot_schedules
  id              uuid pk
  asset_id        uuid → assets.id (cascade)
                  UNIQUE among enabled rows per asset
                  (partial unique index WHERE enabled)
                  — v1 also enforces at most one row per asset overall on upsert
  cadence         text not null  -- 'daily' | 'weekly'
  weekdays        integer[] | null
                  -- ISO weekdays 1=Mon … 7=Sun; required non-empty when weekly
  local_time      text not null  -- 'HH:MM' 24h
  timezone        text not null  -- IANA, e.g. America/New_York
  enabled         boolean not null default true
  requested_by    text not null
  next_job_id     uuid | null → reboot_jobs.id (set null on delete)
  created_at / updated_at

reboot_jobs (existing) + 
  source_schedule_id  uuid | null → reboot_schedules.id (set null on delete)
```

Index claim path unchanged. Optional index on `source_schedule_id` for
“pending child for schedule” lookups.

## Materializer (next occurrence)

Pure function inputs: `cadence`, `weekdays`, `local_time`, `timezone`, `now`
(UTC). Output: next `Date` strictly **after** `now` in that zone.

- **Daily**: next clock time `local_time` today if still future; else tomorrow.  
- **Weekly**: next matching weekday at `local_time` strictly after `now`.  
- **DST**: use a timezone library (e.g. Luxon or Temporal polyfill already in
  stack if present); spring-forward missing hour → next valid local time that
  day or skip to following occurrence per library “next valid” semantics —
  document the chosen library behavior in the plan; never enqueue a past UTC
  instant.  
- **Skip**: if the worker was down across a slot, the next materialize after
  recovery computes from `now` → that slot is skipped automatically.

Idempotency: do not insert if schedule already has a child in
`pending|claimed|running`, or if asset already has any reboot in those
statuses.

## API / code surface

### Cookie actions (`software:deploy`)

- `upsertRebootSchedule({ assetTag, cadence, weekdays?, localTime, timezone })`  
- `setRebootScheduleEnabled({ assetTag, enabled })`  
- `deleteRebootSchedule({ assetTag })`  
- Load schedule with Updates panel props (alongside `rebootJobs`).

### Materialize entry points

- Called from upsert / enable / terminal schedule-job hook.  
- Periodic: prefer **web** (extend an existing light loop or a tiny
  authenticated internal tick used only by the app process) so the collector
  remains WinRM-only. Exact host process chosen in the implementation plan.

### Collector

No recurrence logic. Continues to claim/execute `reboot_jobs` only.

## UI

Computer **Updates** tab, `canInstall` / `software:deploy`:

- Existing one-shot **Schedule reboot** block.  
- New **Recurring reboot** block: cadence, weekdays (weekly), time, next-run
  preview, Enable/Disable, Save, Delete.  
- History rows from a schedule show a “recurring” hint when
  `sourceScheduleId` is set.

## Testing

- Unit: next-occurrence for daily/weekly; past-slot skip; DST spring/fall
  fixtures for the chosen timezone helper.  
- DB/actions: upsert uniqueness; disable/delete cancels child; terminal job
  re-enqueues next; idempotent materialize (no double pending).  
- One-shot conflict while schedule child pending.  
- Panel: recurring controls visible when `canInstall`; disabled Schedule
  reboot button state when appropriate is covered by action error, not only UI.

## Acceptance checklist

- [ ] Admin can set daily or weekly recurring reboot on one computer.  
- [ ] At most one schedule per computer; edit replaces.  
- [ ] Next run is in the future in the saved timezone; missed slots are skipped.  
- [ ] Collector reboots via existing `reboot_jobs` path.  
- [ ] Canceling one history row does not disable the series; next occurrence is booked.  
- [ ] Disable/delete cancels pending child.  
- [ ] One-shot enqueue conflicts cleanly when a reboot is already in-flight.  
- [ ] No fleet / catch-up / install-linked recurrence in this slice.
}