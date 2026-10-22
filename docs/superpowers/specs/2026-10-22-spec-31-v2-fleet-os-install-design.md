# Spec 31 v2 — Fleet OS multi-install from `/patches`

**Date**: 2026-10-22  
**Status**: Draft (design approved in chat; awaiting spec file review)  
**Parent**: [Spec 31 patch management](../../specs/31-patch-management/index.md)  
**Branch**: `feat/spec-31-v2-fleet-os-install` (implementation; this doc on `docs/spec-31-v2-fleet-os-install`)

## Goal

Let an admin with `software:deploy` multi-select computers on `/patches` and
enqueue **OS missing-update installs** for each eligible host, reusing the
existing phase-3 `patch_install_jobs` path. Cap how many installs run at once
fleet-wide so WinRM / WSUS are not hammered.

## Locked decisions

| Topic | Choice |
|---|---|
| Selection model | Computer-centric on `/patches` (not KB-centric) |
| What installs | All **currently missing OS** KBs per host (`apps: []`) |
| Job model | Bulk enqueue of existing `patch_install_jobs` (no batch parent table) |
| Per-host concurrency | Soft one-in-flight (pending / claimed / running) — unchanged |
| Fleet concurrency | Global max concurrent `claimed\|running` via env (default **5**) |
| Permission | `software:deploy` (same as per-host Install) |
| Reboot | **No** — confirm copy states no reboot (same as AC-17/18) |
| Partial success | Yes — skip ineligible hosts; return summary |

## Out of scope (explicit — do not sneak in)

- **Reboot-when-done** on install jobs  
- **WSUS / target-group** scoping  
- **Winget / app** fleet install  
- **KB-centric** “push this KB to every host”  
- Parent **batch** entity / batch-level notify  
- Spec 30 built-in rules for missing / reboot counts  
- End-user portal / Spec 34 v2+

## Behavior

1. On `/patches`, admin with `software:deploy` sees row checkboxes and optional
   select-all for the **current filtered/sorted view**.
2. **Install OS updates** opens a confirm dialog: host count, “all currently
   missing OS updates”, no automatic reboot, jobs run under the concurrency cap.
3. Server action receives asset tags (hard cap, e.g. **100** per request).
4. For each tag:
   - Resolve Computer + IP (same helper as single-host install). No IP → skip
     `no-ip`.
   - Load current missing OS inventory for that asset. Empty → skip `no-missing`.
   - `enqueuePatchInstall` with frozen `{ os: [...all missing], apps: [] }`.
     Already in-flight → skip `already-inflight`.
5. Response: `{ enqueued: string[] /* job ids */, skipped: { tag, reason }[] }`.
6. Worker claim path: if count of jobs in `claimed` or `running` is
   ≥ `PATCH_INSTALL_MAX_CONCURRENT`, return no job (worker retries). Otherwise
   claim next `pending` as today (including stuck reaper).
7. Install, status, and terminal notify stay **per job** (existing patch-install
   notify). Inventory refresh remains best-effort / next Search.

## UI

- Extend `PatchesFleet`: checkbox column; toolbar button **Install OS updates**
  (hidden/disabled without `software:deploy` or with empty selection).
- Confirm dialog copy must state OS-only and no reboot.
- Surface enqueue summary (toast or inline banner): enqueued count + brief skip
  reasons. Do not require a new history page — per-computer Updates job history
  and existing notify remain the audit trail.

## API / code surface

### Web server action

`requestFleetOsPatchInstall({ assetTags: string[] })` in
`patch-install-actions.ts` (or adjacent):

- Auth: cookie user + `software:deploy`.
- Empty tags → `badrequest`.
- Over tag cap → `badrequest`.
- Never throws on a single-host skip; aggregates results.

### DB

- Prefer a small helper (e.g. `enqueueFleetOsPatchInstalls`) that loops
  resolve → build OS-only selection → `enqueuePatchInstall`, rather than
  duplicating one-in-flight logic.
- `claimNextPatchInstall(workerId)`: before the claim `UPDATE`, if
  `COUNT(*) WHERE status IN ('claimed','running')` ≥ max, return `null`.
  Env: `PATCH_INSTALL_MAX_CONCURRENT` (default `5`), same style as
  `PATCH_INSTALL_STUCK_JOB_TIMEOUT_MS`.

### Collector

No new scripts for this slice. Existing `_drain_patch_install` / `PS_INSTALL_OS`
unchanged. Cap is enforced by web claim returning empty when saturated.

### Config

| Var | Where | Default |
|---|---|---|
| `PATCH_INSTALL_MAX_CONCURRENT` | `web/.env` (+ `.env.example`) | `5` |

## Errors

| Case | Result |
|---|---|
| No `software:deploy` | `forbidden` |
| Empty selection / over tag cap | `badrequest` |
| Host no IP / no missing OS / in-flight | Skip with reason in summary |
| Claim at fleet cap | `null` / 204 — not an error |

## Testing

- Bulk enqueue: N jobs created; skips for no-IP, empty missing, already in-flight;
  summary shape.
- Claim: at cap → null; under cap → claims one; only `claimed|running` count.
- UI: deploy perm gates Install; confirm mentions OS-only / no reboot (component
  test).

## Acceptance

- [ ] Multi-select on `/patches` enqueues OS-missing installs for selected hosts.
- [ ] Each job is a normal `patch_install_jobs` row; worker uses existing OS install.
- [ ] At most `PATCH_INSTALL_MAX_CONCURRENT` jobs are `claimed|running` at once.
- [ ] Per-computer one-in-flight still applies.
- [ ] Skips are reported; request is not all-or-nothing.
- [ ] No reboot, no winget in the fleet action, no WSUS, no batch parent table.

## Consequences

- Admins can clear missing OS across many hosts without opening each Updates tab.
- Queue depth can exceed the concurrency cap; jobs wait in `pending` (expected).
- Fleet UX does not install apps; per-host Updates still supports OS + apps.
- Later v2 slices (reboot-when-done, WSUS, KB-centric) remain separate designs.
