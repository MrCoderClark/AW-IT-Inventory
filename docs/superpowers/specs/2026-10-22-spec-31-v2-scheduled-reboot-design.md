# Spec 31 v2 — Scheduled reboot (install-linked + standalone)

**Date**: 2026-10-22  
**Status**: Accepted (spec reviewed; implementation plan ready)  
**Parent**: [Spec 31 patch management](../../specs/31-patch-management/index.md)  
**Related**: [Fleet OS multi-install](./2026-10-22-spec-31-v2-fleet-os-install-design.md)  
**Branch**: `feat/spec-31-v2-scheduled-reboot` (implementation)

## Goal

Let an admin with `software:deploy` schedule a **forced reboot** at a chosen
**date + time**, either:

1. **Standalone** — for a computer (typical: pending reboot), or  
2. **Linked to a patch install** — same datetime chosen when enqueueing install
   (Updates or fleet OS install).

The collector performs the reboot over WinRM when the job is due. No desktop
countdown UI in this slice.

## Locked decisions

| Topic | Choice |
|---|---|
| Surfaces | Install-linked **and** standalone |
| Schedule UI | Exact **date + time** (not delay-after-install, not presets-only) |
| Timezone | Store UTC; UI uses browser-local `datetime-local` |
| Past times | Reject at enqueue (≈1 minute skew tolerance) |
| Late install | If install finishes **after** `scheduledAt` → reboot **ASAP** once install succeeded |
| Linked install fail/cancel | **Auto-cancel** the linked reboot job |
| Linked install success before time | Wait until `scheduledAt`, then claim |
| Job model | Dedicated `reboot_jobs` queue (not folded into patch-install) |
| Reboot style | Forced (`Restart-Computer -Force` or equivalent); no interactive prompt |
| Permission | `software:deploy`; service claim `deploy:agent` |
| One-in-flight | Soft one pending/claimed/running reboot per computer |

## Out of scope (explicit)

- WSUS / target-group scoping  
- Desktop user warning / countdown UI  
- Recurring reboot schedules  
- Reboot-only fleet multi-select as a hard requirement (nice-to-have if cheap; Updates + install-linked are required)  
- End-user portal / Spec 34 v2+  

## Behavior

### Standalone

1. Admin opens Computer **Updates** (or equivalent deploy-capable UI).  
2. Chooses date+time → **Schedule reboot**.  
3. Server creates `reboot_jobs` row (`sourcePatchInstallJobId` null).  
4. Worker claims when `status = pending` and `scheduledAt <= now`.  
5. WinRM forced reboot; status → succeeded/failed; notify requester.

### Install-linked

1. On Install selected (Updates) or Install OS updates (`/patches`), admin may
   check **Also reboot at…** and set date+time.  
2. After successful install enqueue(s), create one linked `reboot_jobs` row per
   enqueued install (same `scheduledAt`).  
3. Claim rules for linked jobs:
   - Linked install must be `succeeded`.  
   - If install is `failed` or `canceled` → set reboot job `canceled` (system).  
   - If install succeeded and `scheduledAt <= now` (including late finish) →
     claim ASAP.  
   - If install succeeded and `scheduledAt` still in the future → wait.

### Cancel

Admin may cancel while `pending` or `claimed` (same fence spirit as patch-install).

## Data model

```
reboot_jobs
  id                         uuid pk
  asset_id                   uuid → assets.id (cascade)
  target_ip                  text not null
  scheduled_at               timestamptz not null
  source_patch_install_job_id uuid | null → patch_install_jobs.id (set null on delete)
  status                     text not null default 'pending'
  requested_by               text not null
  worker_id                  text | null
  claimed_at / started_at / finished_at  timestamptz | null
  result                     jsonb | null
  error                      text | null
  created_at / updated_at
  partial index: claim poll (pending + scheduled_at)
  soft one-in-flight per asset_id (pending|claimed|running)
```

## API / code surface

### Cookie actions (`software:deploy`)

- `requestRebootSchedule({ assetTag, scheduledAtIso })`  
- `cancelRebootJob({ id })`  
- Extend `requestPatchInstall` / `requestFleetOsPatchInstall` with optional
  `rebootAtIso`; on each successful install enqueue, create linked reboot job.

### Service (`deploy:agent`)

- `POST /api/reboot/claim` — next due job  
- `POST /api/reboot/{id}/status` — fenced status updates  

### Collector

- `_drain_reboot` alongside patch-install.  
- Script: forced reboot; short timeout; success = command accepted.  
- Credentials: existing WinRM profiles (never stored on the job row).

### Notify

- On terminal status, notify requester (patch-install notify twin).

## UI

- Updates: Schedule reboot control + datetime; install confirm optional
  “Also reboot at…”; history/cancel for reboot jobs.  
- `/patches` fleet install confirm: optional shared datetime for linked reboots
  on all enqueued hosts.  
- Copy: reboot is **forced**; hosts will restart at the scheduled time (or ASAP
  if install finishes late).

## Errors

| Case | Result |
|---|---|
| No `software:deploy` | forbidden |
| Past `scheduledAt` | badrequest |
| No IP / not a Computer | badrequest |
| Already in-flight reboot | conflict / skip with reason |
| Claim before due / install not succeeded | no job (204) |

## Testing

- Enqueue rejects past time; one-in-flight; linked auto-cancel on install
  fail/cancel.  
- Claim: not before `scheduledAt`; ASAP after late success; blocked until
  install succeeded.  
- UI: datetime required when “also reboot” checked; deploy gate.

## Acceptance

- [ ] Standalone schedule at date+time from Updates.  
- [ ] Install-linked schedule from Updates and fleet OS install.  
- [ ] Late successful install → reboot ASAP.  
- [ ] Install fail/cancel → linked reboot canceled.  
- [ ] Forced WinRM reboot; cancel while pending; notify on terminal.  
- [ ] No WSUS / desktop countdown / recurring in this slice.

## Consequences

- Admins can plan maintenance windows without staying in the app at reboot time.  
- A second durable queue increases worker surface (same claim pattern).  
- Forced reboot can interrupt users — confirm copy must be explicit.  
- Fleet “schedule reboot only” for pending-reboot hosts can reuse
  `requestRebootSchedule` later without a new model.
