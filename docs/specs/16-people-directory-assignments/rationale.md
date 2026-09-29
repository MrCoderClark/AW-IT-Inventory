# 16. People directory and device assignments — rationale

The decision record for spec 16. `/develop` does not read this file; it reads `index.md`.

## Context

OPUS already has the bones of a "who uses this device" idea. The `assets` table
carries an `assigneeId` that points at a `people` row (`name`, `initials`,
`email`), and the asset create/edit form has an assignee picker fed by
`getPeople()`. But nothing populates or manages `people`: the only rows are the
sample names in `seed.ts`. There is no way to add a real employee, edit one,
view a directory, or see what a person holds. On a real fleet the picker is
therefore useless (it offers seed names, not the actual staff), which is what
prompted the ask: "we need users, how can we associate a device without users?"

Two forces shape the answer:

- **Identity boundary.** OPUS runs two databases that the project rules insist
  stay separate: `aw_auth` (Django, the login identities and RBAC) and
  `aw_it_inventory` (Drizzle, the inventory). The people who are handed devices
  are employees, and a fleet has far more employees than login accounts (most
  staff never sign in to OPUS). So the directory of assignees is a different set
  from the set of auth users, and it belongs to the inventory database.

- **Custody over time.** IT asset management cares not just who holds a device
  now but who held it before (returns, reassignments, offboarding). The current
  single `assigneeId` pointer captures only the present. The engineer confirmed
  they want the full history, not just current state.

Not deciding leaves the assignee picker permanently cosmetic and gives the fleet
no record of device custody, which is one of the core jobs of an asset system.

## Options considered

### Option 1: Assignees are aw-auth users

Make a person the same record as an aw-auth login identity; the assignee picker
lists auth users, and assignment stores an auth user id.

**Pros**:
- One identity everywhere; no duplicate person records to keep in step.

**Cons**:
- Every employee you assign a device to would need a login account, which most
  never use. That is a lot of accounts created purely to be pickable.
- Couples the two databases (an inventory row pointing into the auth database),
  which the project rules explicitly warn against.
- Assignment history would straddle a cross service boundary.

### Option 2: OPUS owned people directory with a full assignment history (chosen)

Fill out the existing `people` table into a managed directory in the inventory
database, and add an `asset_assignments` log that records each assignment as a
row with an open and close time. Keep `assets.assigneeId` as the denormalized
"current assignee" so existing table joins keep working, synced inside the same
transaction that opens or closes an assignment.

**Pros**:
- Assignees need no login account; the directory is exactly the set of people
  who hold gear.
- Databases stay separate; no cross service foreign key.
- Full custody history: every device and every person carries a timeline.
- Reuses what already exists (the `people` table, `assigneeId`, the picker,
  the join in `getAssets`).

**Cons**:
- People can exist in two places (here and, separately, as auth users) with no
  link between them. Accepted: they are different populations, and a link can be
  added later if a real need appears (see Follow-up).
- `assets.assigneeId` is a value derived from "the open assignment", stored for
  compatibility, so it must be kept in step transactionally or it drifts.

### Option 3: OPUS owned directory, current state only (no history)

Manage the `people` table and keep only `assigneeId`; drop the idea of a history
log.

**Pros**:
- The least code; no second table, no open/close bookkeeping.

**Cons**:
- No custody history at all, which the engineer explicitly wants. Cannot answer
  "who had this laptop before this person".
- Would have to be reworked into a history model later anyway.

## Rationale

Option 2 wins on the two forces from Context. The identity boundary rules out
Option 1: the assignee population is employees, not login accounts, and tying
them to `aw_auth` would both couple the databases (against the project rules)
and force an account per employee. The custody requirement rules out Option 3:
the engineer wants the history, and retrofitting a log onto a current only model
is more work than building it once.

The one real tension in Option 2 is the denormalized `assets.assigneeId`. The
feature design guidance says do not store derived values. Here it is a
deliberate, narrow exception: `assigneeId` already exists and every asset table,
the dashboard join, and the edit form read it today. Removing it would rewrite
the query layer built across specs 7, 10, and 11 for no user visible gain. So it
stays as a cached pointer to the open assignment's person, and the assignment
engine is the single writer that keeps the two in step inside one transaction.
The `asset_assignments` log is the source of truth for history; `assigneeId` is
the fast read of "now".

Archiving rather than deleting a departed person is a genuine lifecycle state
(offboarding), not a soft delete used to dodge a real delete: the person and
their history are kept on purpose, while their devices go back to the pool. A
true delete is still allowed, but only for a record that was never used (no
assignment history), which keeps the history table free of dangling references
without leaving mistaken entries stuck forever.
