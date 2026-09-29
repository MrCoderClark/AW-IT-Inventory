# Verify: people directory and device assignments · spec 16 · created 2026-09-29
_Steps derived from spec 16 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands
- [ ] `cd web && npm run db:push` → confirm the `asset_assignments` table exists and `people` has the new columns (`department`, `job_title`, `phone`, `employee_id`, `office_location_id`, `status`, `created_at`, `updated_at`) live (`npm run db:studio`, or query the DB) → AC-1, AC-5, AC-11
- [ ] Confirm the partial unique index on `asset_assignments(asset_id) where unassigned_at is null` exists → AC-5, AC-11
- [ ] `cd web && npx tsc --noEmit` → passes → (build sanity)

## UI / manual
- [ ] As an `asset:write` user, open `/people` → the directory lists people with a search box and a current device count; add a person (name only) → they appear; edit them to add email/department/job title/phone/office location → saved → AC-1, AC-2
- [ ] Search the directory by name and by department → the list filters → AC-2
- [ ] Assign a device to a person from the person page → it shows under their current devices and the device count rises; open the device at `/assets/<tag>` → its history shows the open assignment (who, when) → AC-4, AC-5, AC-7
- [ ] Reassign that same device to a second person (from the asset form assignee picker) → the first person's assignment closes and the second opens; the device never shows two open assignments → AC-5, AC-11
- [ ] Return (unassign) the device from the asset detail page → `assigneeId` clears, the assignment closes with a time and actor, and the closed entry shows in both the person's and the device's history → AC-6, AC-7
- [ ] Archive a person who holds two devices → their status shows archived, both devices return to the pool (each `assigneeId` cleared), and they no longer appear in the assignee picker → AC-8
- [ ] Restore the archived person → they are active again and pickable → AC-8
- [ ] Filter `/people` to show archived → archived people appear; default view hides them → AC-2, AC-8
- [ ] Try to delete a person who has assignment history → refused, archive offered instead; delete a person created but never assigned anything → the row is removed → AC-9
- [ ] Sign in as an `asset:read` user without `asset:write` → `/people` and the person and device histories are viewable, and no add/edit/archive/delete/assign/return control is shown → AC-1, AC-10

## Direct-call / negative
- [ ] Invoke `createPerson` / `updatePerson` / `archivePerson` / `deletePerson` / `assignAsset` / `returnAsset` as a user without `asset:write` → each returns a not-permitted result, no write happens → AC-10
- [ ] Create or edit a person to an email already used by another person, in a different case → rejected as a duplicate; repeat with employee id → rejected; a blank email/employee id never collides → AC-3
- [ ] Attempt to assign a device to an archived person → refused → AC-8
- [ ] Read `assets.assigneeId` for an asset and compare to its open `asset_assignments` row → they match; for an unassigned asset `assigneeId` is null and there is no open row → AC-11

## Build notes (added by /develop 2026-09-29)
- Apply order before verifying: `cd web && npm run db:push`, then `npm run db:seed`
  (the seed now opens an `asset_assignments` row per seeded assignee, so seeded
  `assigneeId` values already satisfy AC-11 instead of drifting).
- Exact surfaces built: `/people` (directory, client-side search + Active/Archived/All
  filter + pagination), `/people/[id]` (profile, current devices, history timeline,
  assign/return/archive/restore/delete), and the asset page `/assets/<tag>` gains an
  "Assignment" panel (assign/return + real custody history), replacing the old
  fabricated "Audit History".
- Single-writer check (AC-11): the asset form's assignee picker no longer writes
  `assigneeId` directly — `createAsset`/`updateAsset` route it through the engine's
  `assignAssetTx`/`returnAssetTx` inside the same transaction. The assignee picker
  everywhere lists ACTIVE people only (`getPeople` now filters `status = active`).
- Full web test suite passes (266) and `tsc --noEmit` is clean after the build; the
  spec-16 test suite itself is still to be written by `/test` (build-plan task 8).

## Acceptance-criteria coverage
- AC-1 … create/edit person, initials derived, controls gated · AC-2 … `/people` list, search, device count, active default + archived filter, pagination · AC-3 … email + employee id unique when present, case-insensitive email, blanks allowed · AC-4 … person detail profile + current devices + history · AC-5 … assign opens one row and closes the prior, single open per device, three entry points · AC-6 … return closes the assignment and appears in both histories · AC-7 … device assignment history on the asset page · AC-8 … archive closes assignments + returns devices + removes from picker, restore · AC-9 … delete only with no history, else archive · AC-10 … all mutations gated on `asset:write`, viewing open to `asset:read` · AC-11 … `assigneeId` equals the open assignment or null, never drifts
