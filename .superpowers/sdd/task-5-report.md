# Task 5 Report: Service tick API + collector poll

## Status

**Complete.** All targeted tests pass.

## What shipped

### Web

- **`POST /api/reboot/schedules/due`** (`web/src/app/api/reboot/schedules/due/route.ts`)
  - Service auth: bearer token + `deploy:agent` scope (403 on bad/missing scope).
  - Calls `materializeDueRebootSchedules()`; responds `{ ok: true, checked, created }`.
  - Mirrors `script-schedules/due` pattern.

- **Vitest** (`route.test.ts`): 401 without bearer, 403 invalid token, 200 + materialize call.

### Collector

- **`reboot_schedule_interval_minutes`** on `Config` (default **1**; **0** = off) + `config.example.yaml`.
- **`run_reboot_schedules`** in `reachability.py` — POST to `/api/reboot/schedules/due`, 60s timeout, errors logged without killing scheduler.
- **`worker.py`**: `reboot_schedules_job` on `IntervalTrigger` when interval > 0; startup banner includes `reboot schedules every Nm`.

- **pytest** (`tests/test_reboot_schedules.py`): URL/headers/body; swallows request errors.

## Tests run

```powershell
cd collector; uv run pytest -q tests/test_reboot_schedules.py   # 2 passed
cd ..\web; npx vitest run src/app/api/reboot/schedules/due/route.test.ts   # 3 passed
```

## Commit

Single commit on `feat/spec-31-v2-recurring-reboot` (see git log). Not pushed.

## Notes / concerns

- Default **1 minute** poll is aggressive for large schedule counts; tune via YAML or set `0` if materialization is only driven by terminal-job rematerialize + manual upserts.
- `run_reboot_schedules` does not log success counts (unlike script schedules); add dim logging if ops want visibility.
- Worker uses the same `deploy:agent` token cache as reboot claim — no new service account scopes required.

## Next (plan)

Task 6+ per spec 31 v2 plan: UI for schedules, terminal rematerialize hook verification, integration smoke with worker running.
