# Verify: printer page counter · spec 14 · updated 2026-09-24
_Steps derived from spec 14 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands / setup (run first)
- [ ] `cd web && npm run db:push` → the `printer_counters` table exists (composite PK on
      `asset_id, reading_date`, index `printer_counters_asset_date_idx`); confirm live in
      `npm run db:studio` → AC-1, AC-2 foundation
- [ ] `cd web && npx tsc --noEmit` (or `npm run build`) → web typechecks clean → all ACs
- [ ] Confirm `web/.env` has `OPUS_WEB_CLIENT_ID`/`OPUS_WEB_CLIENT_SECRET` and
      `aw-auth/.env` has `RESEND_API_KEY`/`EMAIL_FROM` (all reused from spec 12) → AC-4, AC-7
- [ ] (Canon) `snmpwalk -v2c -c public <imageFORCE-520-ip> 1.3.6.1.4.1.1602` → pick the real
      life-counter OID and set `counter_oid` in `collector/config.yaml` → AC-1

## Read + record (AC-1, AC-2)
- [ ] `cd collector && uv run python main.py scan --target <printer-ip>/32 --ingest` →
      the printer's `page_count` is read (numeric, not empty with the pinned OID) → AC-1
- [ ] Query `printer_counters` → exactly one row for that printer for today
      (`reading_date` = today, `total_pages` set) → AC-2
- [ ] Run the same `--ingest` scan again the same day → the row is updated
      (`last_read_at` moves), still one row, no duplicate → AC-2

## Detail panel (AC-3)
- [ ] Open a printer's detail page (`/assets/<tag>`) → the "Page counter" panel shows
      Total pages, Today, and Last reading → AC-3
- [ ] A printer with only one day of readings → Today shows "First reading" (no number) → AC-3
- [ ] Insert a next-day row lower than the prior day (simulated device swap) → the panel
      shows "Counter reset", never a negative number → AC-3
- [ ] Two consecutive days of increasing readings → the panel shows the correct
      `+N` day-over-day delta in the recent history → AC-3

## Daily report + manual send (AC-4, AC-5, AC-7)
- [ ] `cd collector && uv run python main.py worker` → the startup line reports
      "counter report 08:05" in the schedule → AC-4
- [ ] Trigger the send endpoint with a `scan:dequeue` service token:
      `POST /api/scan/counter-report/send` → `{ ok, printers, sent: true }` and an email
      arrives listing each printer with its total and today's delta → AC-4
- [ ] A printer with no reading for today appears in the email as "no reading", not dropped → AC-4
- [ ] Sign in as a `scan:write` admin → `/admin` shows "Send counter report now"; click it →
      toast confirms and the same email is sent → AC-5
- [ ] Sign in as a user without `scan:write` → the button is absent; calling
      `sendCounterReportNow` directly is refused → AC-5, AC-7
- [ ] `POST /api/scan/counter-report/send` with no / a wrong-scope token → 401 / 403 → AC-7
- [ ] `POST /v1/notify/printer-counter-report` on aw-auth without `notify:send` → 403 → AC-7

## Retention (AC-6)
- [ ] Insert a `printer_counters` row with `reading_date` older than the window (e.g. 400 days) →
      `POST /api/scan/reachability/prune` (`retentionDays: 365`, `scan:dequeue`) →
      `{ pruned, prunedCounters >= 1 }`; the old counter row is gone, recent rows remain → AC-6

## Acceptance-criteria coverage
- AC-1 … collector reads configurable `counter_oid`; Canon OID pinned by snmpwalk
- AC-2 … ingest upserts one `printer_counters` row per printer per day (idempotent)
- AC-3 … detail-page panel: latest total, today's delta, history; first-reading / counter-reset
- AC-4 … daily email at `counter_report_time` lists total + delta; "no reading" kept
- AC-5 … `scan:write` admin sends on demand; no button + server refusal without it
- AC-6 … the daily prune extends to `printer_counters`
- AC-7 … send endpoint `scan:dequeue`; web→aw-auth `notify:send`; manual `scan:write`
