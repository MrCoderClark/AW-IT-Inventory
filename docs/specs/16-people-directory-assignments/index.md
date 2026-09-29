# 16. People directory and device assignments

**Date**: 2026-09-29
**Status**: Accepted

## Summary

OPUS can point an asset at a person today (`assets.assigneeId`), but there is no
way to manage those people: the only rows are sample seed data, so the assignee
picker is useless on a real fleet. This spec turns the vestigial `people` table
into a managed directory you can add to, edit, and archive, and it adds a full
device assignment history (who held which device, and when). People live in the
inventory database and need no login account. Managing the directory and
assigning devices both reuse the existing `asset:write` permission; anyone with
`asset:read` can view the directory and the histories.

## Requirements

**User stories**:
- As an IT admin, I want to manage a directory of the people who use our devices,
  so I can assign gear to the actual staff instead of seed names.
- As an IT admin, I want to assign a device to a person or take it back from the
  asset form, the person's page, or the device's page, so the action fits wherever
  I am working.
- As anyone with `asset:read`, I want to see who holds a device now and its full
  custody history, and everything a person currently holds plus their past
  assignments, so I can track devices over their life.
- As an IT admin, I want to archive someone who leaves, so their record and history
  survive while their devices return to the pool.

**Acceptance criteria** (the contract):
- **AC-1**: An `asset:write` user can create a person (name required; optional
  email, department, job title, phone, and office location) and edit any of those
  fields. A user without `asset:write` sees the directory read only (no add, edit,
  archive, delete, assign, or return controls). Initials are derived from the name
  automatically, not entered.
- **AC-2**: `/people` lists people with a search box (name, email, department, job
  title) and each person's current device count. Active people show by default;
  archived people are hidden but can be shown with a filter. The list paginates the
  same way the asset tables do.
- **AC-3**: Email is unique when present, compared case insensitively; adding or
  editing a person to a duplicate email is rejected with a clear message. Employee
  id, when present, is likewise unique. A blank email or employee id never collides.
- **AC-4**: A person detail page at `/people/[id]` shows the person's profile, the
  devices they currently hold, and their full assignment history (each entry with
  when it opened, who opened it, and, once closed, when and by whom).
- **AC-5**: Assigning a device to a person opens a new assignment for that device
  and closes any assignment that was open for it, in one transaction, and sets
  `assets.assigneeId` to that person. A device never has more than one open
  assignment. Assigning is reachable from the asset form assignee picker, the
  person detail page, and the asset detail page.
- **AC-6**: Returning (unassigning) a device closes its open assignment (recording
  when and by whom) and clears `assets.assigneeId`. The event then appears in both
  the person's history and the device's history.
- **AC-7**: The asset detail page shows that device's assignment history (each
  person who held it, with the open and close times).
- **AC-8**: Archiving a person sets their status to archived, closes all of their
  open assignments (returning those devices to the pool and clearing each
  `assigneeId`), and removes them from the assignee picker, which offers active
  people only. An archived person can be restored to active.
- **AC-9**: A person can be permanently deleted only when they have no assignment
  history at all. When they have any history, delete is refused and archive is the
  only removal. Deleting an eligible person removes the row.
- **AC-10**: Every mutation (create, edit, archive, restore, delete a person;
  assign or return a device) requires `asset:write`. Viewing the directory, the
  person pages, and both histories is open to any `asset:read` user.
- **AC-11**: `assets.assigneeId` always equals the person of that asset's open
  assignment, or is null when the asset has no open assignment. The two never
  drift.

## Decision

**Chosen option**: Option 2: an OPUS owned people directory in the inventory
database, plus a full `asset_assignments` history log, with `assets.assigneeId`
kept as the denormalized current assignee.

People are employees, not login identities; they live in `aw_it_inventory`
alongside the assets and carry no link to `aw_auth`. Each assignment is a row that
opens when a device is handed out and closes when it comes back, giving every
device and every person a custody timeline; the existing `assigneeId` stays as a
cached pointer to "the current holder", written only by the assignment engine.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch**:

`people` (extend the existing table):
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid PK | no | exists |
| name | text | no | exists |
| initials | text | no | exists; derived from `name` on write, not user entered |
| email | text | yes | unique when present (case insensitive partial unique index) |
| department | text | yes | new |
| jobTitle | text | yes | new |
| phone | text | yes | new |
| employeeId | text | yes | new; unique when present |
| officeLocationId | uuid FK → locations.id | yes | new; `on delete set null`; any node, not leaf only |
| status | enum `people_status` (`active`, `archived`) | no | new; default `active` |
| createdAt / updatedAt | timestamptz | no | new; table has none today |

`asset_assignments` (new, the history log):
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid PK | no | |
| assetId | uuid FK → assets.id | no | `on delete cascade` (device gone, its history goes) |
| personId | uuid FK → people.id | no | `on delete restrict` (enforces archive not delete once history exists) |
| assignedAt | timestamptz | no | default now |
| assignedBy | text | no | admin email from the access token (no FK; admins live in aw-auth, same pattern as `scan_jobs.requestedBy`) |
| unassignedAt | timestamptz | yes | null means the assignment is open (current) |
| unassignedBy | text | yes | admin email from the token, set when it closes |
| createdAt / updatedAt | timestamptz | no | |

Indexes and constraints on `asset_assignments`:
- Partial unique index on `assetId where unassignedAt is null` (at most one open
  assignment per device; enforces AC-5 and AC-11 at the database).
- Index on `(personId, assignedAt desc)` for the person timeline.
- Index on `(assetId, assignedAt desc)` for the device timeline.

**State transitions**:
- Person: `active` ⇄ `archived` (archive and restore). Delete is allowed only from
  a person with no assignment history and removes the row entirely.
- Assignment: `open` (unassignedAt null) → `closed` (unassignedAt set). An
  assignment never reopens; a new hand out is a new row.

**API surface** (Next.js server actions in `src/app/(app)/people-actions.ts`, plus
reuse of the existing asset actions; there are no new route handlers):
| Action | Inputs | Outputs | Auth | Key errors |
|---|---|---|---|---|
| createPerson | name (req), email/department/jobTitle/phone/employeeId/officeLocationId (opt) | person id | `asset:write` | 403 no permission, duplicate email or employee id, blank name |
| updatePerson | personId, same fields | ok | `asset:write` | 403, duplicate email or employee id, not found |
| archivePerson | personId | ok (closes open assignments) | `asset:write` | 403, not found |
| restorePerson | personId | ok | `asset:write` | 403, not found |
| deletePerson | personId | ok | `asset:write` | 403, refused when history exists, not found |
| assignAsset | assetId, personId | ok | `asset:write` | 403, person archived, asset or person not found |
| returnAsset | assetId | ok | `asset:write` | 403, no open assignment (no op) |

The asset form's existing assignee change routes through `assignAsset` /
`returnAsset` rather than writing `assigneeId` directly, so the history log stays
correct from every entry point.

**Key invariants**:
- At most one open assignment per device (partial unique index).
- `assets.assigneeId` equals the open assignment's person, or null (AC-11); the
  assignment engine is its only writer and updates both in one transaction.
- Initials are always derived from the current name.
- Email and employee id are unique when present (email case insensitively); blanks
  never collide.
- The assignee picker lists only `active` people.
- A person's office location may be any node in the locations tree, unlike a
  device, which must sit at a leaf.

**Security model**:
- All mutations require the `asset:write` permission, checked in each server action
  the same way the existing asset actions do (cookie session, `perms` claim). No new
  RBAC permission and no aw-auth reseed.
- Reading the directory, the person pages, and both histories is open to any
  `asset:read` user.
- `assignedBy` / `unassignedBy` record the acting admin's email from the access
  token; no foreign key, because admins live in the auth service.
- Data is internal staff contact detail (name, email, phone), low sensitivity and
  behind the app's auth wall; no external compliance scope applies.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: create a person, assign them a device from the person page, see it
  under their current devices and in the device's history; return it and see both
  histories close, verifies **AC-4**, **AC-5**, **AC-6**, **AC-7**.
- Failure case: reassigning a device that is already assigned closes the first
  assignment and opens exactly one new one; the partial unique index forbids two
  open rows for the same device, verifies **AC-5**, **AC-11**.
- Failure case: archiving a person with two devices closes both assignments,
  returns both to the pool, and drops the person from the picker, verifies
  **AC-8**.
- Failure case: deleting a person who has history is refused; deleting a
  never used person succeeds, verifies **AC-9**.
- Validation: a second person with the same email (any case) is rejected,
  verifies **AC-3**.
- Auth/permission: a user without `asset:write` sees the directory read only and
  every mutating action returns 403, verifies **AC-1**, **AC-10**.

## Build plan

Sliced end to end (tracer bullet; no build approach is recorded in the scope, so
this is the noted default). The migration is task 1; each later task carries the
feature a little further through the layers.

1. **Migration**: extend `people` (email partial unique index, `department`,
   `jobTitle`, `phone`, `employeeId` with its partial unique index,
   `officeLocationId` FK, `people_status` enum + `status` default active,
   `createdAt`/`updatedAt`) and create `asset_assignments` with its open assignment
   partial unique index and the two timeline indexes. Apply with `db:push`.
   Satisfies **AC-1** (data), **AC-3**, **AC-5** (data), **AC-11**.
2. **People data module** `src/db/people.ts` (`server-only`): list with search +
   current device count + status filter, get one person, create, update, archive,
   restore, delete only when no history, initials derivation, email and employee id
   uniqueness checks. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-8**, **AC-9**.
3. **Assignment engine** `src/db/assignments.ts` (`server-only`): `assignAsset` and
   `returnAsset` (transactional close open, open new, sync `assigneeId`, honor the
   single open invariant) and the read helpers `getAssetAssignmentHistory` and
   `getPersonAssignments`. Satisfies **AC-5**, **AC-6**, **AC-7**, **AC-11**.
4. **Server actions** `src/app/(app)/people-actions.ts`: create, update, archive,
   restore, delete, assignAsset, returnAsset, all `asset:write` gated; route the
   existing asset form assignee change through `assignAsset` / `returnAsset`.
   Satisfies **AC-1**, **AC-5**, **AC-6**, **AC-8**, **AC-9**, **AC-10**.
5. **People directory UI**: the `/people` page (table, search, active/archived
   filter, device count, pagination), the person create/edit form dialog (modeled
   on `asset-form-dialog.tsx`), and the "People" nav entry. Controls hidden or read
   only without `asset:write`. Satisfies **AC-1**, **AC-2**, **AC-10**.
6. **Person detail page** `/people/[id]`: profile, current devices, assignment
   history timeline, and the assign, return, archive, restore, and delete controls.
   Satisfies **AC-4**, **AC-6**, **AC-8**, **AC-9**.
7. **Asset detail page**: an assignment history panel plus an assign/return control
   on the device page, and the assignee picker filtered to active people only.
   Satisfies **AC-6**, **AC-7**, **AC-8**.
8. **Tests** across the data module, the assignment engine (the transaction and the
   single open invariant), the actions (the `asset:write` gate both ways and the
   uniqueness rejections), and the directory component. Covers every automatable AC.

## Consequences

**Positive**:
- The assignee picker becomes real: you assign devices to actual staff, and the
  directory is the set of people who hold gear.
- Every device and every person gains a full custody history, a core asset
  management capability.
- No new permission, no aw-auth change, no new env var; it reuses the existing
  auth gate and picker and keeps the two databases separate.

**Negative / tradeoffs**:
- `assets.assigneeId` is a denormalized value that must be kept in step with the
  open assignment. The assignment engine is the single writer, but any future code
  that writes `assigneeId` directly would break the invariant; the asset form must
  route through the engine, not set the column.
- People now exist in the inventory database with no link to aw-auth users. If a
  link is ever needed (for example to show a login user their own devices), it is a
  later addition (see Follow-up).
- One more schema migration and a new write path to maintain.

**Neutral**:
- `initials` stays a stored column but is now always derived; the field is dropped
  from the form.
- The old manual habit of setting `assigneeId` directly on an asset is replaced by
  the assignment actions.

## Follow-up

- [ ] If a link between a directory person and an aw-auth login user is later
  wanted (self service "my devices"), add an optional `authUserId` on `people`; it
  was deliberately left out of v1 to avoid coupling the two databases.
- [ ] The collector already reads `logged_on_user` (`collect_windows.py`) but does
  not send or store it. A later slice could plumb it through ingest and offer it as
  a one click suggested assignee; explicitly out of scope here.
- [ ] Assignment events record who and when but no note or reason. If a reason
  (loaner, lost, replaced) is later useful, add an optional note field to
  `asset_assignments`.
- [ ] Decide whether `/people` needs the spec 11 configurable columns treatment;
  v1 ships a fixed column set.
