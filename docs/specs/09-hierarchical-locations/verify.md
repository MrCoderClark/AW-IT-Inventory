# Verify: hierarchical locations · spec 09 · 2026-09-18

_Steps derived from spec 09 acceptance criteria. `/check verify` runs these;
`/test` locks the durable ones._

## Commands
- [ ] `cd web && npx tsc --noEmit` → typechecks clean → all
- [ ] `cd web && npm test` → the Vitest suite passes (existing + new location
  schema / action / tree / picker / filter tests) → all
- [ ] After `npm run db:push`, confirm the live schema: `locations` table exists
  (with `parent_id` self-FK), `assets.location` is gone, `assets.location_id`
  exists and is nullable → AC-10
- [ ] aw-auth: after `uv run python manage.py seed_rbac`, `location:write` exists
  and is granted to the roles that have `asset:write` → AC-9

## UI / manual (signed in as a user with `asset:write` + `location:write`)
- [ ] `/locations` shows the tree; add a top-level "New York", then add children
  "Bronx" and "Woodside" under it → they appear nested, no refresh → AC-1, AC-2
- [ ] Add a second "Bronx" under "New York" → rejected with a duplicate-sibling
  error, no write → AC-2
- [ ] Rename "Woodside" → the new name shows on `/locations`, in the asset form
  picker, and in the list filter → AC-3
- [ ] Move "Bronx" under a different parent, then to top level → it carries any
  children; moving "New York" under "Bronx" (its own descendant) is rejected as a
  cycle → AC-4
- [ ] In the add/edit asset form, the location picker lists **leaf** locations by
  full path (e.g. "New York / Bronx") plus "No location"; assign a device to
  "New York / Bronx" → saved, shows on the detail page → AC-6
- [ ] Try to add a child under a location that has a device assigned → blocked with
  a "move devices first" message; same block when moving a location under it →
  AC-7
- [ ] Delete an empty leaf → succeeds; delete a location that has children or an
  assigned device → refused with a clear message, nothing removed → AC-5
- [ ] On a category page and on the dashboard, pick "New York" in the location
  filter → assets assigned to any location in its subtree (Bronx, Woodside, …)
  show; clear the filter → all show → AC-8

## Failure / edge
- [ ] Delete or rename a location that was already deleted in another tab → "that
  location no longer exists" error, not a crash → AC-11
- [ ] Assign a device to a location that was just deleted → clean error, no write →
  AC-11
- [ ] Empty states: `/locations` with no locations, and the form picker with no
  leaf locations, both render and behave sensibly → AC-1, AC-6

## Permissions
- [ ] Sign in as a user **without** `location:write` (but with `asset:read`) → the
  `/locations` tree is visible but shows no add/rename/move/delete controls → AC-9
- [ ] (Server gate) a direct `createLocation` / `renameLocation` / `moveLocation` /
  `deleteLocation` call as that user returns the forbidden `ActionResult`, no write
  occurs → AC-9

## Acceptance-criteria coverage
- AC-1 … `/locations` tree view, write-gated controls (UI steps 1, 7; perms)
- AC-2 … create top-level + child, unique-sibling (UI steps 1–2)
- AC-3 … rename reflects everywhere (UI step 3)
- AC-4 … move / re-parent, cycle blocked (UI step 4)
- AC-5 … block-until-empty delete (UI step 7)
- AC-6 … leaf-only picker + assign, shows on detail (UI step 5)
- AC-7 … leaf invariant on add-child / move (UI step 6)
- AC-8 … subtree location filter on lists + dashboard (UI step 8)
- AC-9 … `location:write` gate on controls and actions (commands, perms)
- AC-10 … migration: drop text column, add locationId FK (commands)
- AC-11 … missing-location + concurrency handled cleanly (failure steps)
