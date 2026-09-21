# 13. Discovery type toggles, verify

How to prove each acceptance criterion in [index.md](index.md) against the running
system. `/check verify` drives the real app; this file lists what to do and what to
look for.

Preconditions:
- web (`npm run dev`), aw-auth (`uv run python manage.py runserver`), and Postgres
  are up.
- `db:push` has applied the `discovery_settings` table.
- The collector service account carries `scan:dequeue` (already granted for spec
  12). The collector can reach the web app.
- One user is an `Owner`/`Admin` (has `scan:write`) and one is a `Viewer` (does
  not), both re logged in so the `perms` claim is fresh.
- At least one Windows target and one printer target are reachable on the subnets.

| AC | Steps | Pass condition |
|---|---|---|
| AC-1 | As the admin, open the Admin page, turn Printers off, reload. Open it as a second admin. | The switch shows off and persisted; the second admin sees it off too. A `discovery_settings` row `printer=false` exists. |
| AC-2 | On a fresh `discovery_settings` table (no rows), run a `scan`. | Both computers and printers are discovered, exactly as before the feature. |
| AC-3 | With Printers off, run `uv run python main.py scan` against a subnet with a printer. | The run skips SNMP collection; no printer is ingested and none appears in the discovered devices inbox from that run. Computers still come in. |
| AC-4 | With Computers off, click Scan now on a computer detail page (a web queued manual job). | The worker still claims, scans, and ingests that computer; its live scan data updates. The switch did not block it. |
| AC-5 | (Once spec 12 milestone 3 exists.) Turn Printers off and let a reachability window fire. Then turn it on. | No `printer_checks` rows are written while off; rows resume after turning it on. |
| AC-6 | Stop the web app, then run a `scan`. Then start the web app and run again. | With the web down the collector uses the cached settings (or all on if never cached) and does not crash; the next run refreshes the cache from the live endpoint. |
| AC-7 | As the Viewer, open the Admin page and try the server action directly. Call `GET /api/scan/discovery-settings` with a token missing `scan:dequeue`. | The switches are read only or hidden; the server action returns 403. The endpoint returns 403 for the bad token. |
| AC-8 | Turn both Computers and Printers off, run a `scan`. | The sweep discovers and ingests nothing; the collector logs a warning. A manual Scan now still works. |

Traceability: every AC-1 through AC-8 maps to a build task in the Build plan and to
a critical test scenario in `index.md`.
