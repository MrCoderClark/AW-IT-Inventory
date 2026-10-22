# Task 1 Report — Schema + reboot queue helpers

**Branch:** `feat/spec-31-v2-scheduled-reboot`  
**Commit:** `01e6781` — feat(spec 31): reboot_jobs schema and queue helpers  
**Date:** 2026-10-22

## Summary

Added `reboot_jobs` Drizzle table and `web/src/db/reboot.ts` queue helpers mirroring patch-install: enqueue (past skew + one-in-flight), claim with install-link gate, fenced status, cancel, sync on install terminal, and list-by-tag for Updates history.

## TDD evidence

### RED (Step 2)

Tests were authored in `web/src/db/reboot.test.ts` before `reboot.ts` existed. Expected failure mode:

```
Error: Failed to resolve import "./reboot" from "src/db/reboot.test.ts"
```

(or equivalent module-not-found) until implementation is present.

### GREEN (Step 3)

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/db/reboot.test.ts
```

```
 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  ~15s
```

## Files changed

| File | Change |
|------|--------|
| `web/src/db/schema.ts` | `rebootJobs` table + `RebootJobRow` after `patchInstallJobs` |
| `web/src/db/reboot.ts` | Queue helpers (new) |
| `web/src/db/reboot.test.ts` | 13 unit tests with mocked `db` (new) |

## Interfaces delivered

- `REBOOT_STUCK_JOB_TIMEOUT_MS` — env `REBOOT_STUCK_JOB_TIMEOUT_MS`, default 10 min
- `enqueueRebootJob` — `past-schedule` if `scheduledAt < now - 60_000 ms`; `already-inflight`
- `claimNextReboot` — due pending only; standalone or linked install `succeeded`; reaper on stuck claimed/running
- `updateRebootStatus` — fenced `ok` \| `stale` \| `notfound` (no notify yet — Task 2)
- `cancelRebootJob` — pending/claimed/running → canceled
- `syncLinkedRebootsForInstall` — cancel in-flight linked on `failed`/`canceled`; no-op on `succeeded`
- `listRebootJobsForAssetTag` — history rows with `waitingForCollector`

## Test coverage (plan checklist)

| Test | Status |
|------|--------|
| rejects scheduledAt in the past | pass |
| rejects second in-flight reboot | pass |
| claim null when future (no row from SQL) | pass |
| claim null for blocked linked (SQL gate) | pass |
| claim due standalone | pass |
| claim linked ASAP after install success | pass |
| sync cancel on failed | pass |
| sync cancel on canceled | pass |
| sync no-op on succeeded | pass |
| update fenced ok / stale | pass |
| cancel in-flight | pass |

## Post-merge / operator

**User must run:** `cd web && npm run db:push` to create `reboot_jobs` and indexes.

## Self-review

**Strengths**

- Claim SQL matches design: `scheduled_at <= now()`, LEFT JOIN install, `ORDER BY scheduled_at`, `SKIP LOCKED`
- Enqueue skew matches spec (~1 minute tolerance)
- Patterns align with `patch-install.ts` (IN_FLIGHT, reaper, fence fields)

**Concerns / follow-ups**

1. **Task 2:** Wire `notifyRebootResult` in `updateRebootStatus` on terminal status.
2. **Task 3+:** Call `syncLinkedRebootsForInstall` from `updatePatchInstallStatus` when install reaches terminal state.
3. **Integration:** Claim subquery uses `FOR UPDATE OF r SKIP LOCKED` — validate against real Postgres on first worker drain (Vitest mocks `execute`).
4. **`listRebootJobsForAssetTag`:** Implemented but not unit-tested in this task (plan listed helpers only; optional test in Task 6 UI work).

## Follow-up (Important finding)

Added unit tests for `listRebootJobsForAssetTag` in `web/src/db/reboot.test.ts` (mocked `db.select`, `isWorkerLive`): row mapping + ISO dates, `waitingForCollector` when pending and worker down, empty list.

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/db/reboot.test.ts
```

```
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

Claim SQL Postgres verification (item 3 above) remains deferred — no claim SQL changes.

## Not done (out of scope Task 1)

- API routes, cookie actions, collector drain, UI, notifications type union
