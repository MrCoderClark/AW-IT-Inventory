# Verify: add / edit / delete asset form · spec 08 · 2026-09-16

_Steps derived from spec 08 acceptance criteria. `/check verify` runs these; `/test`
locks the durable ones._

## Commands
- [ ] `cd web && npx tsc --noEmit` (or `npm run build`) → typechecks clean → all
- [ ] `grep -rn "window.confirm\|confirm(" web/src` → the delete flow uses a Dialog, no
  native `confirm()` anywhere → AC-5
- [ ] `grep -rn "generateTag\|TAG_PREFIX" web/src` → defined once (in `lib/tags.ts`) and
  imported by both `scans/actions.ts` and `assets/actions.ts`; no second copy → AC-8
- [ ] `cd web && npm test` → the Vitest suite passes (existing + new form/action tests) → all

## UI / manual (signed in as a user with `asset:write`)
- [ ] On `/dashboard` and on each of `/computers`, `/monitors`, `/printers`, `/phones`,
  `/network`: a "New asset" button is visible → AC-1
- [ ] Click "New asset" on `/monitors` → the modal opens with **Type = Monitor**
  pre-selected → AC-1
- [ ] Fill name + status, save → success toast; the new row appears in the list and its
  tag is `OPUS-MON-XXXXX`; open it → `/assets/<tag>` shows the values entered → AC-2
- [ ] Open the new asset → click "Edit" → the modal opens **pre-filled**; Type is
  read-only and the tag is read-only → AC-3
- [ ] Change model/location/status/assignee, save → detail page reflects the changes
  immediately (no manual refresh) → AC-3
- [ ] Validation: clear the name and save → inline "required" error, no write; set
  warranty date before purchase date → inline error, no write → AC-4
- [ ] Blank an optional field (e.g. vendor) and save → the field shows empty on the
  detail page (stored as null, not "") → AC-4
- [ ] Delete: click Delete → a confirm dialog appears (not a browser popup); confirm →
  success toast, routed to the category page / dashboard, the asset is gone → AC-5
- [ ] Delete an asset that has a matched machine → the machine reappears in the `/scans`
  discovered inbox (unlinked, not deleted) → AC-5, AC-8

## Failure / edge
- [ ] Delete or edit an asset that was already deleted in another tab → "that asset no
  longer exists" error, not a crash → AC-7
- [ ] Assignee dropdown lists existing people plus "Available (unassigned)"; with no
  people seeded it still opens and saves with no assignee → AC-2

## Permissions
- [ ] Sign in as a user **without** `asset:write` → no New / Edit / Delete controls are
  shown on the dashboard, category pages, or the detail page → AC-6
- [ ] (Server gate) a direct `createAsset` / `updateAsset` / `deleteAsset` call as that
  user returns the forbidden `ActionResult`, no write occurs → AC-6

## Acceptance-criteria coverage
- AC-1 … "New asset" on dashboard + 5 category pages, type pre-filled, write-gated (UI steps 1–2)
- AC-2 … create with auto tag, appears without refresh; assignee dropdown (UI step 3, edge step 2)
- AC-3 … edit pre-filled, type + tag read-only, immediate reflect (UI steps 4–5)
- AC-4 … shared zod: required + date rule + blank→null, client and server (UI steps 6–7)
- AC-5 … guarded delete via dialog, machine unlinked to inbox (command 1, UI steps 8–9)
- AC-6 … `asset:write` gate on controls and actions (Permissions steps)
- AC-7 … missing asset on edit/delete handled cleanly (Failure step 1)
- AC-8 … shared tag helper; no regression to inbox/detail/lists (command 3, UI step 9, npm test)
