# 12. Scheduled and manual scans, verify

How to prove each acceptance criterion in [index.md](index.md) against the running system.
`/check verify` drives the real app; this file lists what to do and what to look for.

Preconditions:
- web (`npm run dev`), aw-auth (`uv run python manage.py runserver`), and Postgres are up.
- `db:push` has applied the four new tables; the collector service account has been granted
  `scan:dequeue`, and the `opus-web` service account (scope `notify:send`) exists.
- One user is an `Owner`/`Admin` (has `scan:write`) and one is a `Technician`/`Viewer` (does
  not), both re logged in so the `perms` claim is fresh.
- The collector worker is running: `uv run python main.py worker`.
- At least one Windows target IP is reachable, and at least one printer asset exists with a
  reachable `ipAddress` and one with an unreachable `ipAddress`.

| AC | Steps | Pass condition |
|---|---|---|
| AC-1 | As the admin, open a computer detail page, click "Scan now". | A `scan_jobs` row appears `pending`, then moves to `succeeded`; the computer's health or hardware updates from the run. |
| AC-2 | Select 3 computers in the Computers table, "Scan selected". Then click "Scan all". | The selected job's `targets` holds those 3 IPs. The "Scan all" job's `targets` holds every known device IP (all `machines` plus every printer asset IP), captured at click time. |
| AC-3 | Start a job while two workers poll (or inspect the claim query). Point one target at a dead IP. | The job runs once, never twice. Results post through `/api/ingest/scan`. The dead target is recorded per target; the job still ends `succeeded`. |
| AC-4 | Kill the worker after it claims a job (leave it `claimed`/`running`); wait past the timeout. Then have the original (slow) worker POST a status update for that job. | The reaper returns the job to `pending`; a second worker picks it up. The stale worker's status POST is rejected with 409 (its `workerId`/`claimedAt` no longer match), so it cannot overwrite the newer result. |
| AC-5 | Open the jobs view. Stop the worker and enqueue a job. | Jobs list newest first with status and result summary. With no recent heartbeat, the pending job shows "waiting for collector". |
| AC-6 | Let a scheduled window fire (or trigger the scheduled task path). Inspect `printer_checks`. | Each printer asset gets a row per check with `reachable` and `latencyMs`; the 08:00 run also does a full SNMP collect (a `method='snmp'` row and refreshed printer data). |
| AC-7 | Make a printer fail 2 checks in a row, then succeed once. | After the 2nd fail: `printer_status.isDown` true, UI shows down, exactly one email sent to `Owner`/`Admin` users. On the next success: one recovery email, `isDown` false. No emails between. |
| AC-7 (notify down) | With a printer at the down transition, make Resend unreachable (bad key or blocked egress). | The `printer_status` write still commits and the failure is logged; the check pipeline does not crash. The next check retries the pending transition once Resend is back. |
| AC-8 | Open the printers table and a printer detail page (including a printer never checked yet). | A reachability badge (up, down, or an explicit "not checked" state when no `printer_status` row exists) and recent check history are shown, matching `printer_status` and `printer_checks`. |
| AC-9 | As the non `scan:write` user, load the pages and try the server action directly. Call a worker endpoint with a token missing `scan:dequeue`. | No scan controls are visible; the server action is refused (403). The worker endpoint returns 403. |
| AC-10 | Insert a `printer_checks` row older than the retention window; run the daily prune. | The stale row is removed; rows inside the window remain. |

Traceability: every AC-1 through AC-10 maps to a build task in the Build plan and to a
critical test scenario in `index.md`.
