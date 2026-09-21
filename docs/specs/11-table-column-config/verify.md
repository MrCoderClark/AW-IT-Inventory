# Verify: Global table column configuration · spec 11 · updated 2026-09-21
_Steps derived from spec 11 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands
- [ ] `cd web && npm run db:push` → the `table_column_config` table and `column_view` enum are created; no existing table is altered (inspect with `npm run db:studio`) → AC-1
- [ ] `cd aw-auth && uv run python manage.py seed_rbac` → prints `columns:write` ensured; the Owner and Admin roles include it (idempotent, safe to re-run) → AC-8
- [ ] `cd web && npm run build` (or `npx tsc --noEmit`) → typechecks clean with the registry refactor and new module → build integrity
- [ ] `cd web && npm test` → the Vitest suite passes, including `asset-table.test.tsx` (columns unchanged when no row is saved) → regression, AC-2 / AC-7

## UI / manual
- [ ] Sign in as an Admin (or Owner) → open `/printers` → a "Columns" button shows in the toolbar → AC-4
- [ ] Sign in as a Viewer (`asset:read` only, no `columns:write`) → `/printers` → no "Columns" button → AC-4 / AC-8
- [ ] A view with no saved row (fresh table) renders today's exact default columns for each of the seven views → AC-2
- [ ] As Admin on `/printers`, open the picker → Asset Name and Actions show as locked (can't be toggled off) → AC-4 / AC-6
- [ ] Remove Serial, add Last Sync, move IP above Model, Save → the Printers table updates; reload as a different user → same layout (shared, global) → AC-2 / AC-4 / AC-5
- [ ] The catalog offered per view matches spec: Printer/Network offer IP, Network also MAC, Phone offers Phone number; dashboard/location offer Type, no per-type identifiers → AC-3
- [ ] "Reset to defaults" → the saved row is deleted and the view falls back to the code defaults → AC-5
- [ ] Row-click still navigates to `/assets/[id]`; search, status/type/location filters, sorting, pagination, and New asset all still work; the printer/network Assigned To cell still shows "—" → AC-7
- [ ] On the dashboard/location view with no saved row, Assigned To still drops when nothing shown is assigned to a person; once a layout is saved for that view, the saved list governs → AC-2 / AC-7 note

## Server-side / validation
- [ ] Call `saveColumnConfig`/`resetColumnConfig` as a user without `columns:write` → rejected with a forbidden result (the trust boundary, not just a hidden button) → AC-4 / AC-8
- [ ] Save a view passing an id outside its catalog, or attempting to drop Name → the stored array is sanitized (unknown id dropped, Name + Actions forced) before writing → AC-6
- [ ] A stored array containing an id no longer in the code catalog renders without error (the unknown id is skipped) → AC-6

## Acceptance-criteria coverage
- AC-1 … `npm run db:push` + studio inspection · AC-2 … defaults-unchanged + saved-layout render · AC-3 … per-view catalog check · AC-4 … button visibility + locked columns + server gate · AC-5 … save propagates globally + reset · AC-6 … server sanitize + stale-id tolerance · AC-7 … regression pass + Assigned To dash · AC-8 … seed_rbac + server gate rejection
