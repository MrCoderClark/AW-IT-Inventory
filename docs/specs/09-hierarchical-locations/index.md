# 09. Hierarchical locations

**Date**: 2026-09-18
**Status**: Accepted

> Decision history (Context, Options considered, Rationale) lives in
> [rationale.md](./rationale.md). Verification steps in [verify.md](./verify.md).

## Summary

Today an asset's location is a single free-text box, so "SF — HQ — L4" and
"SF-HQ-L4" are different places and nothing can be rolled up or filtered. This
feature replaces that with a real tree of locations (for example New York, then
Bronx, Woodside, Jamaica under it, nested as deep as you like), managed on a new
`/locations` page. Devices are assigned to a **leaf** location (one with no
children) through the existing add/edit asset form, and the asset tables gain a
location filter that includes everything in a location's subtree. Managing the
tree needs a new `location:write` permission; the old free-text column is dropped.

## Requirements

**User stories**:
- As an IT admin, I want to build a tree of our real locations (regions, sites,
  rooms), so the inventory reflects where things actually are instead of ad-hoc
  free text.
- As an IT admin, I want to assign a device to a specific location, so I can find
  every device at a site or under a region.
- As the team, we want to filter the asset lists by location (including
  everything under a chosen region), so "what is in the Bronx" is one click.
- As an admin, I want deleting or reorganizing locations to be safe, so I never
  silently orphan a device or lose the tree's integrity.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: A dedicated `/locations` page shows the whole location tree as nested
  nodes (a location with its children under it, to any depth). Viewing is gated on
  `asset:read`. A user with `location:write` sees controls to add a child, rename,
  move, and delete a location; a user without it sees none of those controls.
- **AC-2**: Create a location, either a top-level location (no parent) or a child
  of an existing one. Sibling names must be **unique under the same parent**; a
  duplicate name under the same parent is rejected with a clear error. A created
  location appears in the tree without a manual refresh.
- **AC-3**: Rename a location. The new name shows immediately on `/locations` and
  everywhere the location is used (the asset form picker, the list filter, the
  asset detail page).
- **AC-4**: Move a location (re-parent it, carrying its whole subtree) under a
  different parent or to top level. Moving a location under **itself or one of its
  own descendants** (a cycle) is rejected with a clear error.
- **AC-5**: Delete a location **only when it has no child locations and no devices
  assigned** (block until empty). Otherwise the delete is refused with a message
  telling the user to move the children or reassign the devices first. No device is
  silently unassigned and no subtree is silently removed.
- **AC-6**: Devices are assigned to a location **only through a leaf** (a location
  with no children). The add/edit asset form has a location picker listing leaf
  locations by their full path (for example "New York / Bronx") plus a "No
  location" option; the chosen location is saved on the asset and shown on the
  detail page. The Server Action rejects a location id that is missing or not a
  leaf.
- **AC-7**: The leaf-only rule always holds on tree edits: **adding a child to, or
  moving a location under, a location that has devices assigned is blocked** with a
  clear message (it would turn a leaf-with-devices into a parent). The user must
  reassign those devices to a leaf first.
- **AC-8**: The five category pages and the dashboard have a **location filter**.
  Selecting a location shows the assets assigned anywhere in that location's
  subtree (choosing a parent includes every descendant leaf); selecting nothing
  shows all.
- **AC-9**: Every location mutation (create, rename, move, delete) is a Server
  Action gated server-side on **`location:write`** via the existing permission
  check. A user without it does not see the controls and a direct action call
  returns the standard forbidden `ActionResult`. Viewing the tree stays on
  `asset:read`; assigning a location to an asset stays part of the existing
  `asset:write` create/update actions.
- **AC-10**: Migration: the free-text `assets.location` column is **removed** and
  replaced by a nullable `assets.locationId` foreign key to `locations`. Existing
  free-text values are dropped (clean slate); existing assets become "no location"
  until reassigned. No asset is left pointing at a location that does not exist.
- **AC-11**: Editing, moving, or deleting a location that no longer exists, or
  assigning a device to a location that was just deleted, returns a clean "that
  location no longer exists" error (never an uncaught crash). Concurrency is
  last-write-wins (no version guard).

## Decision

**Chosen option**: Option 1: an **adjacency-list** `locations` table (each row
points at its parent), a nullable `assets.locationId` foreign key that must point
at a leaf, four `location:write` Server Actions for the tree, and a subtree filter
computed with a Postgres recursive query. This reuses every pattern spec 08
established (shared zod schema, `ActionResult`, permission-gated Server Actions,
Base UI dialogs), and adds one new permission.

- **Data model**: one `locations` table with a self-referencing `parentId`
  (adjacency list); `assets.location` (text) is replaced by `assets.locationId`
  (nullable FK, `onDelete: restrict`). Depth is unbounded. Subtree membership (for
  the filter and for guards) is computed with a `WITH RECURSIVE` query, not a
  stored path.
- **Leaf-only assignment** is an application invariant: `assets.locationId` must
  reference a location with no children. A plain foreign key cannot express "is a
  leaf", so the create/update asset actions check it, and the tree actions that
  could break it (add child, move) check the target has no assigned devices.
- **Tree management** lives on a new `/locations` page: a nested view with add /
  rename / move / delete driven by `location:write` Server Actions and Base UI
  dialogs, following the `discovered-inbox` / spec 08 idiom (`useTransition`,
  `sonner` toast on the `ActionResult`).
- **Assignment + filtering**: the asset form (spec 08 `AssetFormDialog`) gains a
  leaf-location picker; `AssetTable` gains a location filter that queries the
  chosen location's subtree.
- **New permission**: `location:write`, added to the aw-auth RBAC seed and granted
  to the roles that already hold `asset:write`. Reads stay on `asset:read`.

Alternatives (materialized path, closure table; any-node assignment; reusing
`asset:write`) are weighed in [rationale.md](./rationale.md).

## Feature design

**Data model sketch** (Drizzle, `web/src/db/schema.ts`; conventions match the
existing tables: `uuid` primary keys with `defaultRandom()`, `timestamptz`):

- **`locations`** (new):

  | Column | Type | Null | Notes |
  |---|---|---|---|
  | `id` | uuid PK (`defaultRandom`) | no | |
  | `name` | text | no | |
  | `parentId` | uuid → `locations.id` | yes | self-FK (adjacency list); null = top level; `onDelete: restrict` |
  | `createdAt` / `updatedAt` | timestamptz (`defaultNow`) | no | project convention |

  - Unique constraint on **(`parentId`, `name`)** so siblings cannot share a name
    (two top-level rows both null-parent are also covered; see rationale for the
    NULL-parent uniqueness note).
- **`assets`** (changed): drop `location` (text); add
  **`locationId`** uuid, nullable, `references(() => locations.id, { onDelete: "restrict" })`.
- No change to `people` or `machines`.

**State transitions**: none. A location is a node; it has no lifecycle states.

**API surface** (Server Actions in `web/src/app/(app)/locations/actions.ts`, plus
reads in `web/src/db/queries.ts`; inputs validated by a shared zod schema in
`web/src/lib/location-schema.ts`):

| Action | Signature | Key inputs | Result | Auth | Key errors |
|---|---|---|---|---|---|
| `createLocation` | `(input) => ActionResult` | `name` (req), `parentId` (opt) | `{ ok, message }` | `location:write` | duplicate sibling name; parent missing; parent has devices (AC-7) |
| `renameLocation` | `(id, name) => ActionResult` | `id`, `name` | `{ ok, message }` | `location:write` | duplicate sibling name; location gone |
| `moveLocation` | `(id, newParentId) => ActionResult` | `id`, `newParentId` (null = top) | `{ ok, message }` | `location:write` | cycle (self/descendant); target has devices; location gone |
| `deleteLocation` | `(id) => ActionResult` | `id` | `{ ok, message }` | `location:write` | has children; has devices; location gone |
| `getLocationTree` | `() => LocationNode[]` | — | tree for page + picker | `asset:read` | — |
| assign (existing) | `createAsset` / `updateAsset` extended | `locationId` (opt) | as spec 08 | `asset:write` | not a leaf; location gone (AC-6, AC-11) |
| list filter (existing) | `getAssets` / `getAssetsByType` extended | optional `locationId` | assets in subtree | `asset:read` | — |

**Key invariants**:
- `assets.locationId` is null or references a **leaf** location (no children).
- A location's `parentId` never forms a cycle (a location is never its own
  ancestor).
- Sibling names are unique under a parent.
- A location with children or assigned devices is never deleted (block until
  empty), so no device is orphaned and no subtree vanishes.
- The location tree helper for subtree membership has one definition, used by both
  the list filter and the guards.

**Security model**: the four mutations call the existing permission check for
**`location:write`** (new permission, added to the aw-auth RBAC seed, granted to
roles that already have `asset:write`) and return the standard forbidden
`ActionResult` when it fails. The `/locations` page and the picker read on
`asset:read`, exactly as the asset surfaces do, and pass a `canWrite` prop from the
RSC page to hide the controls (mirrors spec 08). Assigning a location to an asset
is part of the existing `asset:write` create/update actions. This is an internal,
auth-walled tool; no regulated-data compliance scope.

**Configuration required**:
- No new environment variables.
- Prerequisite: re-run the aw-auth RBAC seed so the new `location:write` permission
  exists and is granted (`uv run python manage.py seed_rbac`), before the web write
  controls work.

**Critical test scenarios** (each maps to an acceptance criterion in Requirements):
- Happy path: build New York → Bronx on `/locations`, assign a device to Bronx via
  the form (leaf picker shows "New York / Bronx"), then filter a category page by
  New York and see that device, verifies **AC-1**, **AC-2**, **AC-6**, **AC-8**.
- Leaf/tree guards: adding a child under a location that has devices is blocked;
  moving a location under its own descendant is blocked; both return a clear error
  and write nothing, verifies **AC-4**, **AC-7**.
- Delete safety: deleting a location that still has children or devices is refused
  with a "move/reassign first" message; deleting an empty leaf succeeds, verifies
  **AC-5**.
- Failure case: assigning a device to a location deleted a moment ago, or renaming
  a location that no longer exists, returns "that location no longer exists", not a
  crash, verifies **AC-11**.
- Auth/permission: a user without `location:write` sees no add/rename/move/delete
  controls, and a direct `createLocation` call returns the forbidden result,
  verifies **AC-9**.
- Migration: after the migration the `location` text column is gone, `locationId`
  exists and is null for every seeded asset, and no asset references a missing
  location, verifies **AC-10**.

## Build plan

Built as a thin end-to-end thread first (Tracer Bullet, the project default as in
specs 07 and 08), then widened to the other tree operations, assignment, and
filtering.

1. **Migration + seed**: add the `locations` table (self-FK `parentId`,
   `onDelete: restrict`, unique `(parentId, name)`, timestamps); drop
   `assets.location`; add nullable `assets.locationId` (FK, `onDelete: restrict`).
   Update `db/seed.ts` to stop seeding free-text locations (assets seed with no
   location). Satisfies **AC-10**.
2. **New permission**: add `location:write` to the aw-auth RBAC seed
   (`seed_rbac`), granted to the roles that already hold `asset:write`. Document
   the re-seed step. Groundwork for **AC-9**.
3. **Shared foundations (web)**: the zod schema `web/src/lib/location-schema.ts`
   (name required/trimmed, `parentId` nullable uuid); queries in `db/queries.ts`
   (`getLocationTree`, a leaf check, a `WITH RECURSIVE` subtree id helper shared by
   the filter and the guards). Groundwork for **AC-2**, **AC-7**, **AC-8**.
4. **Create thread, end to end**: `createLocation` action (validate, unique-sibling
   check, parent-has-no-devices guard, insert, `revalidatePath`) + the `/locations`
   page rendering the tree, with an "Add location" / "Add child" Base UI dialog
   gated on `location:write`. Satisfies **AC-1**, **AC-2**, and the create half of
   **AC-9**.
5. **Rename, move, delete**: the three remaining actions + their controls on
   `/locations`. Move enforces the cycle guard and the target-has-no-devices guard;
   delete is block-until-empty. Satisfies **AC-3**, **AC-4**, **AC-5**, **AC-7**.
6. **Assign a location**: add the leaf-location picker (full path + "No location")
   to `AssetFormDialog`; extend the asset zod schema and `createAsset`/`updateAsset`
   to accept `locationId` with a server-side leaf check; show the location on the
   asset detail page. Satisfies **AC-6**, the leaf guard half of **AC-7**, and the
   FK/"gone" path of **AC-11**.
7. **Location filter**: add a location filter to `AssetTable` and wire the
   subtree query into the five category pages and the dashboard. Satisfies
   **AC-8**.
8. **Edge cases + verify**: "location no longer exists" handling on
   rename/move/delete/assign, last-write-wins confirmed, empty-tree and
   no-location states, and a `verify.md` pass. Satisfies **AC-11**; guards
   **AC-1** through **AC-10** (no regression).

## Consequences

**Positive**:
- Locations become real, queryable data: rollups by region, a subtree filter, and
  no more free-text drift ("SF-HQ" vs "SF — HQ").
- Reuses spec 08's patterns wholesale (shared zod schema, gated Server Actions,
  Base UI dialogs, `canWrite` prop), so the new surface is small and familiar.
- Block-until-empty deletes and the cycle/leaf guards mean the tree cannot reach a
  broken or orphaning state through the UI.

**Negative / tradeoffs**:
- Adds a second write permission (`location:write`), which means an aw-auth RBAC
  seed change and a re-seed step, so this is no longer a web-only change.
- Adjacency list needs a recursive query for subtree reads; each filter is a
  `WITH RECURSIVE` scan (fine at this fleet's scale, a cost to revisit only if the
  tree grows very large).
- Leaf-only assignment forces reorganizing (moving devices) before you can nest a
  location that already holds devices, an extra step for the admin.
- Dropping the free-text `location` column discards the current seed location text;
  every existing asset starts with no location until reassigned.

**Neutral**:
- No new environment variables. Depends on the existing `people`/`assets` tables;
  `machines` is untouched.
- Delete is a hard delete of an empty location (consistent with spec 08's hard
  delete of assets); no archive table.

## Follow-up

- [ ] Bulk-assign a location to many devices at once (this spec assigns one device
      at a time via the form).
- [ ] Inline "create a new location" from the asset form picker (this spec is
      pick-existing-leaf only; new locations are made on `/locations`).
- [ ] A `location:read` permission if location visibility ever needs to differ
      from `asset:read` (reused here to avoid a second read gate).
- [ ] Consider a materialized-path or closure-table model if subtree filtering
      becomes a measured bottleneck at large tree sizes.
- [ ] Locations conventions (the leaf-only invariant, the recursive subtree
      helper) are not yet in `web/AGENTS.md`; add a note once the pattern lands.

## Rationale

See [rationale.md](./rationale.md) for the options considered and why this shape
was chosen.
