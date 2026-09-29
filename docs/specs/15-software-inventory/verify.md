# Verify: software inventory · spec 15 · updated 2026-09-29
_Steps derived from spec 15 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands
- [ ] `cd web && npm run db:push` → confirm `tracked_software` and `installed_software` tables exist live (`npm run db:studio`, or query the DB) → AC-1, AC-3
- [ ] `cd web && npx tsc --noEmit` → passes → (build sanity)
- [ ] `cd collector && uv run python main.py scan --target <a-managed-windows-ip>/32` (dry run, no `--ingest`) → the run JSON in `collector/out/` shows a `software` array on the Windows host with `name`/`version`/`publisher`/`install_date` → AC-2

## UI / manual
- [ ] As a `scan:write` admin, open `/admin` → the "Tracked software" card shows → add "Chrome" → toast confirms, it appears in the list → AC-1
- [ ] On `/admin`, remove a tracked title → toast confirms, it disappears; its recorded matches cascade away → AC-1
- [ ] With "Chrome" tracked, run `collector … scan --ingest` against a managed Computer that has Chrome installed → open `/software` → "Chrome" shows with a computer count ≥ 1 and its version(s) → AC-3, AC-4
- [ ] On `/software`, a tracked title installed on no machines shows a count of 0 (not hidden) → AC-4
- [ ] On `/software`, click a title → the drill-down lists the Computer assets that have it, each with its version, linking to `/assets/<tag>` → AC-5
- [ ] Open a matched computer's detail page (`/assets/<tag>`) → the "Tracked software" panel lists its tracked programs (name, version, publisher) → AC-6
- [ ] Open a matched computer with no tracked software → the panel shows the empty state, not an error → AC-6
- [ ] Sign in as an `asset:read` user without `scan:write` → `/software` and the drill-down are viewable → AC-4; `/admin` shows no "Tracked software" card → AC-7
- [ ] Scan a Windows machine still in the discovered inbox (not matched to any Computer asset) that has a tracked title installed → no `installed_software` row is stored for it → AC-3

## Direct-call / negative
- [ ] Invoke `addTrackedSoftwareAction` / `removeTrackedSoftwareAction` as a user without `scan:write` (e.g. from a client without the perm) → returns `{ ok: false }`, no write happens → AC-7
- [ ] Add a title that already exists in a different case (e.g. "chrome" when "Chrome" is tracked) → rejected as a duplicate → AC-1

## Acceptance-criteria coverage
- AC-1 … add/remove on `/admin`, persistence, case-insensitive duplicate reject · AC-2 … registry Uninstall read in the dry-run JSON · AC-3 … matched-Computer store + full replace + unmatched/non-Computer stores nothing · AC-4 … `/software` every title, distinct count (0 shown), versions, `asset:read` view · AC-5 … per-title drill-down to machines with versions and links · AC-6 … computer detail panel with empty state · AC-7 … no controls without `scan:write`, server action refuses a direct call
