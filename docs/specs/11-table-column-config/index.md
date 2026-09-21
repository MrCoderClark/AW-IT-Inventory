# 11. Global table column configuration

**Date**: 2026-09-18
**Status**: Accepted

> Decision history (Context, Options considered, Rationale) lives in
> [rationale.md](./rationale.md).

## Summary

Today the columns on every asset table are fixed in code (`columnsFor(type)` for
the five category pages, `allColumns` for the dashboard and location pages). This
spec lets an admin choose which columns each of those seven views shows, and in
what order, saved once and seen by everyone. The choices live in one new
`table_column_config` table keyed by view, editing is gated on a new
`columns:write` permission, and the picker is a "Columns" button in the table
toolbar that only permitted admins see. When a view has no saved row it renders
exactly the current hardcoded columns, so nothing changes until an admin opts in.

## Requirements

**User stories**:
- As an IT admin, I want to add or remove columns on an asset table (for example
  show a printer's IP, hide the serial number), so each list shows the facts my
  team actually uses.
- As an IT admin, I want to reorder the columns, so the most useful ones come
  first.
- As the team, we want one shared layout per view, so everyone sees the same
  columns without each person configuring their own.
- As the team, we want the tables to keep working exactly as they do now until an
  admin changes them, so this adds control without disrupting anyone.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: A new `table_column_config` table stores one row per view, keyed by a
  `column_view` value (one of `computer`, `monitor`, `printer`, `phone`,
  `network`, `dashboard`, `location`), with an ordered JSON array of stable
  column ids. The migration is additive: no existing table is changed and no data
  is transformed.
- **AC-2**: Each of the seven views renders its columns from its saved row when
  one exists: the saved ids, in saved order, keeping only ids that still exist in
  that view's catalog. When no row exists, the view renders today's default
  columns unchanged (`columnsFor(type)` for a category page, `allColumns` for the
  dashboard and location pages).
- **AC-3**: The available columns (the catalog) for a category page are the shared
  columns (id, name, model, serial, assignee, location, status, last sync) plus
  that type's already surfaced identifier columns: Printer and Network add IP,
  Network also adds MAC, Phone adds phone number. The catalog for the dashboard
  and location pages is the shared columns plus the Type column, with no
  type-specific identifier columns (they would be blank for most rows). No new
  database join is added; only the identifier fields already carried on the asset
  object (`ip`, `mac`, `phoneNumber`) are offered.
- **AC-4**: An admin with `columns:write` sees a "Columns" control in the table
  toolbar; a user without it does not, and both Server Actions reject a caller who
  lacks it. The picker toggles each column on or off and reorders columns (drag or
  up/down). Asset Name and the Actions menu are locked: always shown, always Name
  first and Actions last, never removable.
- **AC-5**: Saving writes the chosen ordered visible column ids for that view and
  the change is global: every user sees the new layout on their next page load
  (the affected route is revalidated). A "Reset to defaults" control deletes the
  saved row so the view falls back to the code defaults.
- **AC-6**: The Server Action re-validates the submitted ids against the view's
  catalog before writing: ids not in the catalog are dropped, the locked columns
  cannot be removed, and at minimum Name and Actions always render. A stored id
  for a column later removed from the code catalog is ignored on render without an
  error.
- **AC-7**: No regression. Search, the status/type/location filters, sorting,
  pagination, row-click navigation to `/assets/[id]`, and the New-asset flow all
  keep working on every view. The per-cell "not applicable" dash for the Assigned
  To column on printer and network rows stays. The dashboard's all-types table and
  the location pages keep working.
- **AC-8**: `columns:write` is added to the aw-auth RBAC seed (`seed_rbac.py`) and
  granted to the Owner and Admin roles. Reading a view stays on the page's existing
  `asset:read` gate; the layout itself is public to any viewer (there is one shared
  layout).

## Options considered

See [rationale.md](./rationale.md) for the options weighed (fix in place, a saved
override delta, per-user layouts) and why the chosen shape won.

## Decision

**Chosen option**: a global, per-view saved layout stored as an explicit ordered
list of column ids, merged over a code-owned catalog, edited inline by a new
`columns:write` role.

Extend the existing config-driven `AssetTable` rather than replace it (fix in
place). Introduce stable string ids for every column, a code-owned catalog of what
each view can show, and code-owned defaults matching today's tables. A saved row is
a subset of the catalog in a chosen order. The table renders the saved list when
present, otherwise the defaults. The picker and both write actions are gated on a
new `columns:write` permission.

## Feature design

**Data model sketch** (Drizzle, `web/src/db/schema.ts`; conventions match the
existing tables). One new table and one new enum:

- **`column_view`** pgEnum: `computer`, `monitor`, `printer`, `phone`, `network`,
  `dashboard`, `location`. Names the seven configurable views.
- **`table_column_config`** table:
  - `viewKey` `column_view` **primary key** (one row per view).
  - `columns` `jsonb` **NOT NULL**: an ordered array of stable column id strings,
    for example `["id","name","ip","status","location","actions"]`.
  - `updatedAt` timestamptz, `defaultNow()` (hygiene, matches the other tables).

No change to `assets`, `people`, `machines`, `locations`, or the per-type detail
tables. The `columns` array holds ids only, so a removed or renamed column is
tolerated (filtered out on render). NOT NULL is safe here because the table is
brand new (no existing rows to backfill).

**Column ids** (stable, stored in the array): `id`, `name`, `type`, `serial`,
`model`, `assignee`, `location`, `status`, `lastSync`, `ip`, `mac`, `phoneNumber`,
`actions`. `name` and `actions` are the locked ids.

**Per-view catalog and defaults** (code-owned, in a new pure module
`web/src/lib/table-columns.ts` so both the server validation and the client picker
import them):

| View | Catalog (what can be shown) | Default (shown when no saved row) |
|---|---|---|
| computer | shared | id, name, model, serial, assignee, location, status, lastSync, actions |
| monitor | shared | id, name, model, serial, assignee, location, status, actions |
| printer | shared + ip | id, name, model, serial, ip, location, status, lastSync, actions |
| network | shared + ip + mac | id, name, model, serial, ip, mac, location, status, actions |
| phone | shared + phoneNumber | id, name, model, serial, phoneNumber, assignee, location, status, actions |
| dashboard | shared + type | id, name, type, serial, model, assignee, location, status, lastSync, actions |
| location | shared + type | id, name, type, serial, model, assignee, location, status, lastSync, actions |

"shared" = id, name, model, serial, assignee, location, status, lastSync
(plus the locked name and actions). The category catalogs exclude `type` (the page
is already one type); the mixed catalogs exclude the identifier columns.

**Render resolution** (in `AssetTable`, replacing the current `columnsFor` /
`allColumns` selection): `ids = savedRow ?? defaultsFor(view)`; keep only ids in
`catalogFor(view)`, in that order; force `name` present (inject first if missing)
and `actions` last (append or move to end). The result maps id to a `ColumnDef`
via a `COLUMN_REGISTRY` (the existing column definitions keyed by id, with their
JSX cells, staying in `asset-table.tsx`). The per-cell Assigned To dash for
printer and network rows (`typeTakesAssignee`) is unchanged, it is cell rendering,
not column selection.

**Mixed-view note**: when a saved row exists for `dashboard` or `location`, it
fully defines the columns, so today's dynamic "drop the Assigned To column when
nothing shown is assigned to a person" no longer applies for that view (the admin's
list wins). With no saved row, that dynamic default behavior is preserved.

**API surface** (reads in `web/src/db/queries.ts`; Server Actions in a new
`web/src/app/(app)/columns-actions.ts`, gated server-side):

| Action | Kind | Key inputs | Result | Auth |
|---|---|---|---|---|
| `getColumnConfig(view)` | read (queries.ts) | `view` | `string[]` or `null` (null = use defaults) | page's `asset:read` |
| `saveColumnConfig(view, ids)` | Server Action | `view`, ordered `ids[]` | `{ ok, message }` | `columns:write` |
| `resetColumnConfig(view)` | Server Action | `view` | `{ ok, message }` | `columns:write` |

Each of the seven RSC pages reads its view's config and passes a serializable
`columnOrder: string[] | null` plus its `view` key into `AssetTable` config, and
passes `canConfigureColumns` (from `hasPermission(user, "columns:write")`) so the
client shows the picker button. Both actions upsert or delete by primary key, then
call `revalidatePath` for the edited route so the global change propagates.

**Key invariants**:
- One saved row per view (primary key on `viewKey`); saving is an upsert, last
  write wins (acceptable at this low edit frequency).
- The stored array is authoritative for order and membership, but always filtered
  through the code catalog on render, so code and data cannot drift into a broken
  table.
- Name and Actions always render; an empty or all-removed saved array still yields
  a usable table (Name first, Actions last).
- Reads need no new permission: there is exactly one shared layout, visible to any
  user who can already see the page. Only writes need `columns:write`.
- The config is read fresh per request in the RSC (no separate cache), so a save
  plus `revalidatePath` is enough for every user to see the new layout on next
  load.

**Security model**: viewing a table stays gated on the page's existing `asset:read`
(unchanged). Editing the layout is gated on the new `columns:write`, checked in
both Server Actions (the trust boundary) and used to show or hide the picker
button. Owner and Admin get `columns:write` in the seed. This is an internal,
auth-walled tool; no regulated-data compliance scope.

**Configuration required**: none (no new env vars). Two operational steps, see the
Migration plan: `npm run db:push` in `web/` to create the table, and reseed
aw-auth (`uv run python manage.py seed_rbac`) to add the permission.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: an admin opens the Printers table, removes Serial, adds Last sync,
  reorders IP before Model, and saves; every user now sees Printers without Serial,
  with Last sync, and with IP moved, verifies **AC-2**, **AC-4**, **AC-5**.
- Fallback: a view with no saved row renders today's exact default columns,
  verifies **AC-2**.
- Validation: a Server Action call with an id outside the view's catalog, or an
  attempt to remove Name, is sanitized (id dropped, Name kept) before writing,
  verifies **AC-6**.
- Stale id: a saved array containing an id no longer in the code catalog renders
  without error (the unknown id is skipped), verifies **AC-6**.
- Reset: "Reset to defaults" deletes the saved row and the view falls back to code
  defaults, verifies **AC-5**.
- Auth: a user without `columns:write` sees no "Columns" button and a direct action
  call is rejected, verifies **AC-4**, **AC-8**.
- Regression: search, filters, sorting, pagination, row-click, and New asset keep
  working; the printer/network Assigned To dash stays, verifies **AC-7**.

## Migration plan

**Strategy**: additive, no data transform. The new capability is gated by a new
permission, so it is effectively off until an admin uses it.

**Phases**:
1. **web schema**: add the `column_view` enum and `table_column_config` table
   (`npm run db:push`). Purely additive; existing tables untouched.
2. **aw-auth permission**: add `columns:write` to `seed_rbac.py` and grant it to
   Owner and Admin, then reseed (`uv run python manage.py seed_rbac`, idempotent).
   Admins pick up the new scope on their next token refresh (re-login if needed).
3. **web code**: the column registry refactor, the read, the actions, and the
   picker. Behavior is identical to today until a row is saved.

**Rollback**: revert the web code; drop `table_column_config` and the `column_view`
enum; remove `columns:write` from the seed and reseed. No data is lost (the table
holds only layout preferences). Reverting the code alone already restores the
hardcoded columns, since with the table absent every view falls back to defaults.

**Risks**: the two services must both be updated (schema in web, permission in
aw-auth); if only web ships, no one has `columns:write` and the button never shows
(safe, just inert). Admins may need to re-authenticate to receive the new scope.

## Build plan

Built as a thin end-to-end thread first (Tracer Bullet, the project default as in
specs 07 to 10): make one view configurable end to end, then widen to all seven.

1. **Migration**: add the `column_view` enum and `table_column_config` table
   (`viewKey` PK, `columns` jsonb NOT NULL, `updatedAt`). Additive. Satisfies
   **AC-1**.
2. **aw-auth permission**: add `columns:write` to `seed_rbac.py` PERMISSIONS and to
   the Owner and Admin roles; reseed. Satisfies **AC-8**.
3. **Column registry refactor**: give every column a stable id, build
   `COLUMN_REGISTRY` (id to `ColumnDef`) in `asset-table.tsx`, and a pure
   `web/src/lib/table-columns.ts` with `catalogFor(view)`, `defaultsFor(view)`,
   the locked set, and column labels. Change `AssetTable` to accept `view` and
   `columnOrder` and resolve columns by the render rule (fallback to defaults when
   `columnOrder` is null). Behavior-identical when no row exists. Satisfies
   **AC-2**, **AC-3**, **AC-6**.
4. **Read + wire one view**: add `getColumnConfig(view)` in `queries.ts`; wire the
   Printers page to read its config and pass `view`, `columnOrder`, and
   `canConfigureColumns`. Prove the end-to-end thread on one page. Satisfies
   **AC-2** (for Printer).
5. **Server Actions**: `saveColumnConfig` and `resetColumnConfig` in
   `columns-actions.ts`, gated on `columns:write`, re-validated against the
   catalog, then `revalidatePath`. Satisfies **AC-5**, **AC-6**.
6. **Picker UI**: a `ColumnPickerDialog` client component (checkbox toggles, drag
   or up/down reorder, Save and Reset to defaults), opened by a "Columns" toolbar
   button shown only when `canConfigureColumns`. Satisfies **AC-4**, **AC-5**.
7. **Widen + verify**: wire the remaining six views (the four other category pages,
   the dashboard, the location page) to read and pass their config; regression pass
   over search, filters, sorting, pagination, row-click, New asset, and the
   printer/network Assigned To dash. Satisfies **AC-2**, **AC-7**.

## Consequences

**Positive**:
- Admins tailor every asset list to how the team actually works, without a code
  change, and everyone shares one consistent layout per view.
- The change is fully additive and inert until used: no saved row means the exact
  current tables, so the blast radius before anyone opts in is zero.
- Columns become addressable by stable id, which is the groundwork for surfacing
  more type-specific fields as columns later (spec 10's remaining follow-up).

**Negative / tradeoffs**:
- A new permission crosses the service boundary: aw-auth must be reseeded and
  admins may need to re-authenticate to receive `columns:write`.
- The saved list is an explicit subset, so a newly added code column is available
  to add but is not shown automatically until an admin adds it (predictable, but
  someone must act to surface it).
- Last write wins on concurrent admin edits (no locking); acceptable given how
  rarely layouts change, but two admins editing the same view at once can clobber
  each other.
- Only the three already surfaced identifier fields are offered on category pages;
  the rest of each type's detail fields still need list-query joins to become
  columns (kept out of scope here, a follow-up).

**Neutral**:
- The dynamic "drop Assigned To when none assigned" default is preserved only until
  a mixed view is configured, after which the saved list governs.
- No change to reconciliation, ingest, the discovered-devices inbox, or the asset
  detail page.

## Follow-up

- [ ] Offer the remaining per-type detail fields (page count, RAM, screen size,
      form factor, and so on) as columns by left-joining the detail tables into
      `getAssetsByType` / `getAssets`; this spec deliberately limits category
      columns to the identifiers already on the asset object (spec 10's open
      follow-up).
- [ ] Record `updatedBy` on `table_column_config` if a light audit of who changed a
      layout is wanted later (deferred now; the audit option was declined).
- [ ] Per-user column layouts on top of the global default, if individuals later
      want to hide columns just for themselves (out of scope now; this feature is
      deliberately global).
- [ ] Add the column-config conventions to `web/AGENTS.md` once the pattern lands
      (via `/sync`): the id registry, the catalog/defaults module, and the
      `columns:write` gate.

## Rationale

See [rationale.md](./rationale.md) for the options considered and why this shape was
chosen.
