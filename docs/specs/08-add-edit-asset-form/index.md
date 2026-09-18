# 08. Add / edit / delete asset form

**Date**: 2026-09-16
**Status**: Accepted

> Decision history (Context, Options considered, Rationale) lives in
> [rationale.md](./rationale.md). Verification steps in [verify.md](./verify.md).

## Summary

Assets can only reach the database today through the seed or a collector scan.
This spec adds the missing manual path: an IT admin can **create**, **edit**, and
**delete** an asset from the web UI. The form is a **modal dialog** (the same Base UI
`Dialog` pattern the discovered-devices inbox already uses), opened from a "New asset"
button on the dashboard and each category page, and from the "Edit" button on the
asset detail page. Every write is a **Server Action gated on `asset:write`**, and all
input is checked by a single **zod schema shared by the form and the action**. No
database schema change: the `assets` table already has every field.

## Requirements

**User stories**:
- As an IT admin, I want to add a new asset from the UI, so I can record hardware that
  the collector cannot scan (monitors, spare phones, network gear) without editing the
  seed or the database by hand.
- As an IT admin, I want to edit an asset's details, so I can fix a wrong model,
  reassign it, move it, or change its status as the fleet changes.
- As an IT admin, I want to delete an asset that was created in error or scrapped, so
  the inventory stays accurate.
- As the team, we want bad input rejected before it reaches the database, so records
  stay trustworthy.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: A "New asset" button appears in the dashboard header and on each of the
  five category pages (`/computers`, `/monitors`, `/printers`, `/phones`, `/network`).
  Clicking it opens the create form in a modal dialog. On a category page the **Type is
  pre-selected** to that category. The button is shown only to a user with
  `asset:write`.
- **AC-2**: The create form collects: name, type, status, serial, model, assignee,
  location, vendor, spec, cost center, purchase date, warranty until. Submitting a valid
  form creates an asset with an **auto-generated unique tag** (`OPUS-<PREFIX>-XXXXX`,
  prefix from the type), shows a success toast, and the new asset is visible in the
  matching category list and on its own detail page without a manual refresh.
- **AC-3**: On `/assets/[id]`, the "Edit" button opens the **same form pre-filled** with
  the asset's current values. **Type is read-only on edit** (locked; only set at
  create) and the **tag is read-only** (the immutable human key). Saving valid changes
  updates the asset and the detail page reflects the new values immediately.
- **AC-4**: Validation is enforced by one shared zod schema on **both** the client form
  and the Server Action (defense in depth): **name, type, status are required**; if both
  purchase date and warranty until are set, **warranty until must be on or after
  purchase date**. Serial, model, assignee, location, vendor, spec, cost center are
  optional (blank saved as null). Invalid input shows inline field errors, and the
  action rejects it with an `ActionResult` error rather than writing.
- **AC-5**: A guarded **Delete** control on the detail page removes the asset only after
  an **explicit in-app confirmation step** (a confirm dialog, never the native
  `window.confirm`). A linked machine's `assetId` and any `people` reference are set null
  by the existing foreign keys (the machine returns to the discovered inbox), not
  deleted. After a successful delete the user is routed to the asset's category page (or
  the dashboard) with a success toast.
- **AC-6**: Every write (create, update, delete) is a Server Action gated server-side on
  `asset:write` via the existing `requireWrite` pattern. A user without `asset:write`
  does not see the New / Edit / Delete controls, and the actions reject the call with the
  standard forbidden `ActionResult`. Reads stay gated on `asset:read`.
- **AC-7**: Concurrency is **last write wins** (no version guard); the most recent Save
  persists. Editing or deleting an asset that no longer exists returns a clear "that
  asset no longer exists" error, never a crash.
- **AC-8**: No regression. The detail page, category tables, dashboard, and
  discovered-devices inbox keep working. The tag-generation helper is **shared** between
  the inbox quick-create (`createAssetFromDevice`) and the new `createAsset` action, so
  the two cannot diverge.

## Decision

**Chosen option**: Option 1: a modal-dialog asset form backed by three new
`asset:write` Server Actions and one shared zod schema, reusing every existing pattern
(no schema change, no new detail route).

- **Form UI**: one client component (`AssetFormDialog`) drives both create and edit,
  built on the Base UI `Dialog` already in `components/ui/dialog.tsx`, following the
  `LinkDialog` idiom in `discovered-inbox.tsx` (`useTransition`, `sonner` toast on the
  `ActionResult`). Delete uses a second small confirm dialog, not `window.confirm`.
- **Server Actions** (new `web/src/app/(app)/assets/actions.ts`): `createAsset`,
  `updateAsset`, `deleteAsset`, each returning the existing `ActionResult`, each gated by
  the same `requireWrite()` helper, each calling `revalidatePath` for the affected
  surfaces. This mirrors `scans/actions.ts` exactly.
- **Validation**: one zod schema (`web/src/lib/asset-schema.ts`) parsed on the client
  (inline field errors) and re-parsed in each action (the trust boundary).
- **Shared tag helper**: `generateTag` / `TAG_PREFIX` move out of `scans/actions.ts`
  into `web/src/lib/tags.ts`, imported by both call sites (satisfies AC-8).

Alternatives (dedicated create/edit pages; a REST route handler; hand-rolled
validation) are weighed in [rationale.md](./rationale.md).

## Feature design

**Data model sketch**: no schema change. Reuses `assets`, `people`, `machines` as
defined in `web/src/db/schema.ts`.

- `assets`: the write target. `tag` unique (auto-generated at create, immutable after).
  `name`, `type`, `status` are `notNull` (the required set). All other columns nullable.
  `assigneeId` is a nullable FK to `people(id)` (`onDelete: set null`). `updatedAt`
  bumped on every write.
- `people`: read-only source for the assignee dropdown (this spec does not create
  people). New query `getPeople()` returns `{ id, name, initials }[]`.
- `machines.assetId` (`onDelete: set null`): on asset delete, a matched machine is
  unlinked automatically and reappears in the discovered inbox. No extra code needed.

**Editable fields** (form → column):

| Field | Column | Required | Notes |
|---|---|---|---|
| Name | `name` | yes | free text |
| Type | `type` | yes (create only) | enum; **read-only on edit** |
| Status | `status` | yes | enum: deployed / maintenance / online / storage |
| Serial | `serial` | no | not enforced unique (stays nullable) |
| Model | `model` | no | |
| Assignee | `assigneeId` | no | dropdown of existing people + "Available (unassigned)" |
| Location | `location` | no | |
| Vendor | `vendor` | no | |
| Spec | `spec` | no | |
| Cost center | `costCenter` | no | |
| Purchase date | `purchaseDate` | no | date |
| Warranty until | `warrantyUntil` | no | date; must be >= purchase date if both set |
| Tag | `tag` | auto | generated at create, **read-only** everywhere |

**State transitions**: none. `status` is a free dropdown, not a state machine.

**API surface** (Server Actions, not HTTP routes; inputs validated by the shared zod
schema):

| Action | Signature | Key inputs | Result | Auth | Key errors |
|---|---|---|---|---|---|
| `createAsset` | `(input: AssetInput) => ActionResult` | name, type, status (req), optional fields | `{ ok, message, tag }` | `asset:write` | invalid input; tag-generation clash (retry) |
| `updateAsset` | `(tag: string, input: AssetInput) => ActionResult` | tag + edited fields (type ignored / locked) | `{ ok, message }` | `asset:write` | invalid input; asset no longer exists |
| `deleteAsset` | `(tag: string) => ActionResult` | tag | `{ ok, message }` | `asset:write` | asset no longer exists |

**Key invariants**:
- `tag` is generated once at create and never changes; edit and delete key off it.
- `type` is set at create and never changes (locked on edit), so the tag prefix and the
  asset type always agree.
- name, type, status are always present (DB `notNull` + zod required).
- An optional field submitted blank is stored as `null`, not an empty string.
- The tag-generation helper has exactly one definition, shared by both create paths.

**Security model**: all three actions call `requireWrite()` (the existing
`getCurrentUser` + `hasPermission(user, "asset:write")`) and return the standard
forbidden `ActionResult` when it fails. The UI hides New / Edit / Delete when the user
lacks `asset:write` (passed as a `canWrite` prop from the RSC pages, exactly as
`/scans` does). Reads remain `asset:read`. No new permissions; both already exist in the
RBAC seed. This is an internal, auth-walled tool; no regulated-data compliance scope.

**Configuration required**: none. No new env vars, no migration, no `db:push`.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: create a Monitor from `/monitors` (type pre-filled), it gets a
  `OPUS-MON-XXXXX` tag and appears in the list; then edit it and the detail page updates,
  verifies **AC-1**, **AC-2**, **AC-3**.
- Validation: submit with a blank name, or warranty date before purchase date, gets
  inline errors and the action returns an error without writing, verifies **AC-4**.
- Failure case: delete an asset that another admin already deleted returns "that asset
  no longer exists", not a crash; a matched machine is unlinked and returns to the
  inbox, verifies **AC-5**, **AC-7**.
- Auth/permission: a user without `asset:write` sees no New/Edit/Delete controls, and a
  direct action call returns the forbidden result, verifies **AC-6**.
- Regression: inbox quick-create and the new create action produce identically shaped
  tags from the one shared helper, verifies **AC-8**.

## Build plan

Built as a thin end-to-end thread first (Tracer Bullet; no build approach is recorded
for this project, so the default is end-to-end slices, as in spec 07), then widened to
the other operations and entry points.

1. **Shared foundations**: extract `generateTag` / `TAG_PREFIX` to
   `web/src/lib/tags.ts` and repoint `scans/actions.ts` to it; add the zod schema
   `web/src/lib/asset-schema.ts` (`ASSET_TYPES`, `ASSET_STATUSES`, `assetInputSchema`,
   inferred `AssetInput`, blank→null coercion, date cross-check); add `getPeople()` to
   `db/queries.ts`. Groundwork for AC-2, AC-4, AC-8.
2. **Create thread (end to end)**: `createAsset` action (validate, generate unique tag
   with the existing retry, insert, `revalidatePath`) + `AssetFormDialog` in create mode
   wired to a single "New asset" button on the dashboard, gated on `asset:write`.
   Satisfies AC-2, and the create half of AC-6.
3. **Edit mode**: `updateAsset` action + reuse `AssetFormDialog` pre-filled from the
   detail page's asset (type and tag read-only); replace the "Edit" placeholder toast on
   `/assets/[id]`. The detail page passes the current `assigneeId` and `canWrite`.
   Satisfies AC-3.
4. **Delete**: `deleteAsset` action + a confirm dialog on the detail page (no native
   confirm); route away and toast on success. Satisfies AC-5.
5. **All create entry points**: add the "New asset" button (type pre-filled) to each of
   the five category pages. Satisfies AC-1.
6. **Validation hardening + edge cases**: inline field errors from the shared schema;
   "asset no longer exists" handling in update/delete; last-write-wins confirmed (no
   version guard). Satisfies AC-4, AC-7.
7. **Polish + verify**: loading/disabled states while pending, empty people list case,
   and a `verify.md` pass. Guards AC-8 (no regression).

## Consequences

**Positive**:
- The inventory is finally editable from the UI; assets no longer require a seed edit or
  direct database access. The detail page's "Edit" placeholder becomes real.
- One form component and one zod schema serve create and edit, and the tag helper is
  shared, so there is little duplicated surface.
- Deleting an asset cleanly returns a matched machine to the discovered inbox for free,
  through the existing foreign keys.

**Negative / tradeoffs**:
- Introduces `zod` as a new dependency and a new validation pattern (the project's forms
  were previously hand-rolled). Justified by sharing one schema across the client and the
  trust boundary; the team now maintains that pattern.
- Last-write-wins can silently overwrite a concurrent edit. Acceptable for a few admins;
  an optimistic `updatedAt` guard is the later path if it bites.
- Assignee is "pick from existing people only"; assigning to a brand-new person still
  needs that person seeded first. Inline person-create is deferred (Follow-up).
- Type locked on edit means a miscategorised asset must be deleted and re-created rather
  than retyped.

**Neutral**:
- No schema change, no migration; `Software` and non-asset nav items are untouched.
- Delete is a hard delete (the `assets` row is removed). Given the FK `set null`
  behavior and a small fleet, an archive table is not warranted now (see Follow-up).

## Follow-up

- [ ] Inline "add new person" in the assignee picker (this spec is pick-existing-only).
- [ ] Reconsider the standalone "Reassign" action on the detail page now that assignee
      is editable in the form; likely fold it in or drop it.
- [ ] Optimistic-concurrency guard (`updatedAt` check) if concurrent edits become a real
      problem.
- [ ] Consider soft-archive (an `archivedAt` column) instead of hard delete if audit
      history of retired assets is later required.
- [ ] `zod` conventions are not yet in `web/AGENTS.md`; add a note there once the schema
      pattern is established, since validation will recur across future forms.

## Rationale

See [rationale.md](./rationale.md) for the options considered and why this shape was
chosen.
