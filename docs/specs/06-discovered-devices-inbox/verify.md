# Verify: discovered-devices inbox · spec 06 · updated 2026-08-26
_Steps derived from spec 06 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands
- [ ] `cd web && npm run db:push` → applies schema; then `npm run db:studio` (or `\d machines`) shows the new `ignored_at` column on `machines` → AC-5, AC-6
- [ ] `cd web && npx tsc --noEmit` (or `npm run build`) → typechecks clean → all
- [ ] After ignoring a device, re-POST the same host to `/api/ingest/scan` (PowerShell `Invoke-RestMethod` with a service token) → the device stays under **Ignored**, does not reappear in the active inbox, and `ignored_at` is unchanged → AC-6
- [ ] Quick-create a device, then invoke `createAssetFromDevice` again for the same machine (or double-click) → `select count(*) from assets` did not increase the second time; the machine keeps its single `asset_id` → AC-8

## UI / manual
- [ ] Sign in as an admin, visit `/scans` → the inbox lists unmatched, non-ignored machines showing hostname, IP, subnet, kind, OS, serial, and last-seen; with more than 8 rows the Previous/Next pager appears → AC-1
- [ ] A device whose serial equals an existing asset's serial shows that asset as the top suggestion labelled "Exact serial match"; a device with no plausible match shows no suggestions → AC-2
- [ ] Click **Link** on a suggestion → the device leaves the inbox; open that asset's detail drawer → the live-scan panel shows the machine and the asset's Last Sync is updated → AC-2, AC-3
- [ ] Click **Link…** → search the picker by name/tag/serial → pick an asset → the device leaves the inbox and is linked to that asset → AC-3
- [ ] Click **Create asset** on an unmatched Windows device → a new **Computer** asset appears with an `OPUS-…` tag, the scanned serial and a spec summary prefilled, status **Storage**, linked to the machine; the device leaves the inbox → AC-4
- [ ] Click **Ignore** → the device leaves the inbox and appears under the **Ignored** tab; click **Restore** there → it returns to the active inbox → AC-5
- [ ] With every scanned device matched or ignored, the inbox shows the "Inbox zero" empty state; the Ignored tab with nothing dismissed shows its own empty state → AC-8
- [ ] Sign in as a user with `scan:read` but not `asset:write` → `/scans` loads but no Link / Create / Ignore controls are shown → AC-7
- [ ] Sign in as a user without `scan:read` → `/scans` shows the "you don't have permission" message instead of the inbox → AC-7

## Acceptance-criteria coverage
- AC-1 … inbox list + pagination (UI step 1)
- AC-2 … ranked suggestions, none when no match (UI steps 2, 3)
- AC-3 … link via suggestion and via searchable picker; lastSync updates (UI steps 3, 4)
- AC-4 … quick-create with generated tag, inferred type, prefilled serial/spec, status storage (UI step 5)
- AC-5 … ignore → Ignored filter → restore (UI step 6) + column exists (command 1)
- AC-6 … ignore survives re-scan (command 3) + column exists (command 1)
- AC-7 … server-side permission gate; controls hidden without asset:write; page gated on scan:read (UI steps 8, 9)
- AC-8 … empty states (UI step 7); concurrent resolve is a safe no-op with no duplicate asset (command 4)
