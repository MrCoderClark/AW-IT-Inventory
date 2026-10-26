# 32. Script library — saved PowerShell, run on one Computer

**Date**: 2026-10-19
**Status**: Accepted (v1)

## Summary

OPUS gains a **script library**: admins save reusable **PowerShell** snippets and
**Run** one on a managed **Computer** from that computer's detail page. The
collector worker claims the job, executes the frozen script body over WinRM
(time-boxed), captures exit code + output tail, and reports back. History is
per computer (who, when, outcome).

Outbound-only: web never WinRM; collector dials out (same pattern as specs 23 /
24 / 31). v1 is **library + run-now on one Computer**. Multi-target, schedule,
and on-alert are v2.

## Requirements

**User stories**:
- As an IT admin, I want a library of approved scripts so I don't paste ad-hoc
  PowerShell into a remote terminal every time.
- As an IT admin, I want to run a chosen script on one computer and see exit code
  + output without watching WinRM.
- As a security owner, I want runs gated (`software:deploy`), audited, and free of
  stored credentials on the job row.

### Acceptance criteria (v1)

- **AC-1**: `scripts` table stores name, description, body (text ≤ 64 KB),
  `timeoutSeconds` (default **120**, max **600**), audit fields; soft archive.
- **AC-2**: `/scripts` page (Manage nav, `software:deploy`): list, create, edit,
  archive/delete.
- **AC-3**: Computer detail **Scripts** panel: pick a library script → **Run**;
  soft one-in-flight-per-computer; requires Computer + IP.
- **AC-4**: `script_run_jobs` freezes `scriptSnapshot` `{ name, body, timeoutSeconds }`
  + `targetIp` / `requestedBy`. Status machine matches deploy. No passwords.
- **AC-5**: Collector claims `/api/script-runs/claim`, runs over WinRM, posts
  `/api/script-runs/{id}/status` under claim fence. Result:
  `{ exitCode, outputTail }`. Service scope **`deploy:agent`**.
- **AC-6**: Notify on terminal status (deploy-style). Cancel while
  pending/claimed/running (does not kill an in-flight WinRM session).
- **AC-7**: Permission: reuse **`software:deploy`**. No new RBAC / service scope.
- **AC-8**: v1 never schedules, never fans out to multiple computers, never
  injects secrets/parameters beyond the frozen body.

## Data model

```
scripts
  id, name, description, body text not null
  timeout_seconds int not null default 120
  created_by, updated_by text
  archived_at timestamptz | null
  created_at, updated_at

script_run_jobs
  id, asset_id → assets, target_ip
  script_id → scripts (set null on delete)
  script_snapshot jsonb not null
  status pending|claimed|running|succeeded|failed|canceled
  requested_by, worker_id, claimed_at, started_at, finished_at
  result jsonb | null, error text | null
  requested_at, created_at, updated_at
  partial indexes: pending claim; in-flight per asset
```

## API / surfaces

| Surface | Auth |
|---|---|
| `/scripts` CRUD (actions / routes) | cookie + `software:deploy` |
| `enqueueScriptRun` / `cancelScriptRun` | cookie + `software:deploy` |
| `/api/script-runs/claim` | service `deploy:agent` |
| `/api/script-runs/{id}/status` | service `deploy:agent` |

## Collector

`script_run.py` + worker drain (deploy poll cadence). Transfer body to a temp
`.ps1` on the target (SMB / base64 path like deploy script steps) or run via
time-boxed `run_ps` when small; capture exit + combined output tail (~4 KB);
always clean temp; never reboot.

## UI

- `/scripts` — library (HeroHeader + table + editor dialog).
- Computer detail — Scripts panel next to Software deploy: picker + Run + history.

## Phases

1. **v1** — AC-1–8. ✅ shipped (library + run-now on one Computer).
2. **v2** — multi-computer / location fan-out + daily/weekly schedules.
   **AC-9–12.** ✅ shipped.
3. **v3 — on-alert remediation** — [design](../../superpowers/specs/2026-10-26-script-on-alert-design.md):
   optional `alert_rules.remediation_script_id`; enqueue on Spec 30 fire only
   (shipped #125).
4. **v4 — device-group targets** — [design](../../superpowers/specs/2026-10-26-device-groups-design.md):
   dynamic groups (location / OS / compliance) as `ScriptTargetSpec` mode
   `group` for Run on… and schedules (implementing on `feat/device-groups`).
5. **Later** — script parameters; non-PowerShell; patch/alert group consumers.

### Phase 2 — Fan-out + schedules

- **AC-9**: From `/scripts`, **Run on…** with targets = multi-select Computer tags
  **or** a location subtree. Resolves to Computers with IPs; skips no-IP; soft-skips
  hosts with an in-flight script run. Creates a `script_run_batches` row and one
  `script_run_jobs` per host (reuses v1 runner).
- **AC-10**: `script_schedules` — script + targetSpec + daily|weekly + time
  (+ weekday for weekly), enabled, lastRunAt/nextRunAt. Manage on `/scripts`.
- **AC-11**: Worker polls due schedules (same shape as report delivery), materializes
  each into a batch, advances nextRunAt. Service `deploy:agent`.
- **AC-12**: Still `software:deploy`. Per-host history unchanged; batch id on jobs.

## Related

- [28](../28-rmm-roadmap/index.md) · [23](../23-software-deployment/index.md) ·
  [24](../24-remote-actions/index.md) · [31](../31-patch-management/index.md) ·
  [26](../26-reporting-engine/index.md) (schedule tick pattern)
