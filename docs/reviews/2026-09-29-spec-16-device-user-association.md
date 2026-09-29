# Review, spec/16-device-user-association, 2026-09-29

**Reviewed by**: Claude Sonnet 5 (author on Claude Opus 4.8)
**Scope**: 20 files (15 new, 5 tracked-modified), branch vs `main` (merge base `f542970`)
**Verdict**: Changes requested → **all majors resolved 2026-09-29**

## Resolution (2026-09-29, after the review)

All three majors and two of the four minors are fixed; full web suite green (369).

- **Major, concurrent double-assign race**: `assignAssetTx`/`assignAsset` now catch the
  23505 on `asset_assignments_open_uq` (`isOpenAssignmentRace`) and return a clean
  `already-assigned` result; `people-actions.ts` and the `assets/actions.ts` reroute map
  it to a "just assigned to someone else, try again" message. Tests added in
  `assignments.test.ts` and `people-actions.test.ts`.
- **Major, AC-11 reroute untested**: `assets/actions.test.ts` now mocks `@/db/assignments`
  and adds six cases (create routes the assignee through the engine and drops the direct
  `assigneeId` write; archived assignee rolls back; no-assignee skips the engine; update
  assign/return/unchanged branches), with the `updateAsset` base mocks fixed to return a
  real `assigneeId`.
- **Major, `person-detail.tsx` untested**: added `person-detail.test.tsx` (8 tests):
  render, read-only gate, delete gating on history, archived Restore/no-assign state,
  return-a-device, archive confirm.
- **Minor, N+1 in `archivePerson`**: the per-device `assigneeId` clear is now one batched
  `inArray` update.
- **Minor, LIKE wildcards**: directory search now escapes `%`/`_`/`\` via `escapeLike`
  (unit-tested).
- **Deferred (follow-ups, not fixed)**: the assign picker on the person page still doesn't
  label devices held by someone else (needs current-holder data plumbed into the picker),
  and `Field`/`fmtDateTime` stay duplicated across the two detail components (the review
  itself deferred this one).

---

_Original review below._

**Reviewed by**: Claude Sonnet 5
**Scope**: 20 files (15 new, 5 tracked-modified), branch vs `main` (merge base `f542970`)
**Verdict**: Changes requested

## Summary

Spec 16 turns the vestigial `people` table into a managed directory and adds a full
`asset_assignments` custody log, with `assets.assigneeId` kept in step by a single
transactional engine (`src/db/assignments.ts`). The core design is sound: the
partial unique index enforces "at most one open assignment," and
`createAsset`/`updateAsset` correctly stopped writing `assigneeId` directly,
routing every assignee change through `assignAssetTx`/`returnAssetTx` inside the
same transaction as the asset write — exactly the AC-11 contract the spec asks
for. The gap is on the edges: the exact reroute this review was asked to
scrutinize (`assets/actions.ts`'s new assignee handling) has no real test
coverage despite `actions.test.ts` appearing to cover it, the richest new
component (`person-detail.tsx`) ships with zero tests, and the engine has no
handling for the concurrent-double-assign race that its own sibling module
(`people.ts`) handles correctly for the analogous uniqueness race.

## Major

### 🟠 The AC-11 reroute in `assets/actions.ts` is effectively untested, despite tests that look like they cover it, `web/src/app/(app)/assets/actions.test.ts:128` and `:200`

**Problem**: `createAsset`/`updateAsset` now call `assignAssetTx`/`returnAssetTx`
(`web/src/app/(app)/assets/actions.ts:238-239`, `:316-319`) — the exact code this
review was asked to scrutinize hardest. But `actions.test.ts` never mocks
`@/db/assignments`, and its fake `db`/`tx` object only defines
`insert`/`update`/`delete`/`transaction` (no `select`) — so a real call into
`assignAssetTx` (which does three `tx.select(...)` calls before touching
anything) would throw a `TypeError` if it were ever reached.

It is never reached. The two tests titled "returns a clean error (not a crash)
when the assignee was deleted mid-flight" (lines 128 and 200) set
`h.returning.mockRejectedValue({ code: "23503" })`. `h.returning` is the *one*
shared mock backing every `.returning()` call in the chain, and the very first
`.returning()` call in `createAsset` is the asset row insert itself
(`tx.insert(assets).values(...).returning({id, tag})`), which now runs *before*
the `if (input.assigneeId)` block that calls `assignAssetTx`. Since `assigneeId`
is no longer part of that insert's values (spec 16 intentionally removed it, see
`actions.ts:222-224`), the reject fires immediately and the test never reaches
the new code at all — it's asserting the pre-existing generic-FK-fallback
behavior (`fkViolationResult`'s "unknown FK → default to ASSIGNEE_GONE"), not the
new `assignAssetTx` → `person-not-found` → `AssignFailure` → `assignFailureResult`
chain the spec added.

The `updateAsset` version of the test has a second, compounding issue: its
`.returning()` mock resolves `[{ type: "Monitor" }]`, which has no `assigneeId`
key, so `updated[0].assigneeId` is `undefined` — not `null`. `desired !== current`
(`"" !== undefined`) is then always true, so *every* `updateAsset` test
(including the ones with no intent to touch the assignee) falls into the
`returnAssetTx` branch and calls the real `returnAssetTx(tx, undefined, ...)`.
It happens to survive only because `returnAssetTx`'s malformed-id guard
(`UUID_RE.test(assetId)`) short-circuits before touching `tx.update`. That's a
lucky accident, not a verified behavior, and it means the `desired`/`current`
comparison branch (assign vs. return vs. no-op) is never actually exercised
under realistic mock data.

**Why it matters**: This is the central invariant of the whole spec (AC-11), and
a regression here — e.g. someone re-adding a direct `assigneeId` write, or a
future edit to `assignFailureResult`'s error mapping — would not be caught by
this test file, because none of its assertions actually depend on
`assignAssetTx`/`returnAssetTx` running correctly. The suite is green for the
wrong reason.

**Suggested fix**: Add `@/db/assignments` to the mocks in `actions.test.ts` (mock
`assignAssetTx`/`returnAssetTx` directly, matching how `people-actions.test.ts`
mocks `@/db/assignments`), then add real cases: create with a valid assignee
(asserts `assignAssetTx` called with the new asset id), create/update where
`assignAssetTx` returns `{ ok: false, error: "person-archived" }` (asserts the
transaction rolls back and the mapped message comes back), update that clears an
assignee (asserts `returnAssetTx` called), and update where the assignee is
unchanged (asserts neither is called). Also fix the `updateAsset` base tests'
`.returning()` mock to include a real `assigneeId` (`null` or a uuid) so the
`current` value isn't accidentally `undefined`.

### 🟠 `person-detail.tsx` has no test file at all

**Problem**: `web/src/components/person-detail.tsx` is the largest and most
logic-dense new component in the feature — assign/return per current device, the
`pickable` device filter, archive/restore/delete with three confirmation
dialogs, `canDelete` gating on history length, and the "N devices return to the
pool" archive-confirm copy. Its siblings (`people-directory.tsx`,
`person-form-dialog.tsx`) both got dedicated `.test.tsx` files; this one did not
(confirmed against `git status` — no `person-detail.test.tsx` exists anywhere in
the branch).

**Why it matters**: This is where AC-4, AC-6, AC-8, and AC-9 actually render and
where a user clicks. A regression in the `canDelete` gate (e.g. showing delete
for a person with history), the archive confirmation wiring, or the assign/return
button handlers would ship with the full suite green.

**Suggested fix**: Add `person-detail.test.tsx` covering at least: delete button
hidden/shown based on `history.length`, archive confirm calls
`archivePersonAction` with the person id, assign picker excludes only this
person's own current devices (see the related Minor below), and return calls
`returnAssetAction` with the right device id — mirroring the mocking pattern
already used in `people-directory.test.tsx`.

### 🟠 No handling for the concurrent double-assign race, `web/src/db/assignments.ts:94-120`

**Problem**: `assignAssetTx` selects for an existing open assignment
(`:94-103`), then closes it and inserts a new one (`:108-120`). Under Postgres's
default READ COMMITTED isolation, two concurrent `assignAsset` calls for the same
device can both pass the "no open row" (or "open row for someone else") check
before either commits, and both then attempt to INSERT a new open row. The
partial unique index `asset_assignments_open_uq` (correctly) rejects the second
insert with SQLSTATE 23505 — but nothing in `assignAssetTx`, `assignAsset`,
`assignAssetAction` (`web/src/app/(app)/people-actions.ts:164-189`, no try/catch
around `assignAsset`), or the `assets/actions.ts` reroute catches a 23505. It
only checks `fkViolationResult`, which matches 23503 (foreign key), not 23505
(unique). The loser gets a raw, unhandled Postgres error instead of a clean
`ActionResult`.

Contrast this with `web/src/db/people.ts`, which handles the *exact same class*
of race correctly for email/employee-id uniqueness
(`isUniqueViolation`/`uniqueField`, `people.ts:257-291`, `:311-340`) — the
pattern exists in this PR, just not applied to the assignment engine, which is
the module whose own doc comment calls the partial unique index the AC-11
enforcement mechanism.

**Why it matters**: Data integrity is fine (the DB constraint holds, AC-11 never
drifts) — but the user-facing failure mode is an ungraceful crash/toast instead
of "someone just updated this device, please retry," on the one entry point
(three UI surfaces funnel into this) most likely to see near-simultaneous writes
from two admins. Low probability on a small IT team, but it's the exact
invariant this review was asked to scrutinize, and there's no test covering it
either (unlike `people.test.ts`'s explicit 23505-race test for `createPerson`).

**Suggested fix**: Wrap the insert in `assignAssetTx` with a catch for SQLSTATE
23505 on `asset_assignments_open_uq`, returning a new `AssignError` variant
(e.g. `"already-assigned"`) mapped to a friendly "someone else just updated this
device, try again" message, the same shape `people.ts` already uses.

## Minor

### 🟡 The person-page assign picker doesn't flag devices already held by someone else, `web/src/components/person-detail.tsx:106-108`

**Problem**: `pickable = assignableAssets.filter((a) => !heldTags.has(a.tag))`
only excludes devices this person already holds. Every other Computer/Monitor/
Phone — including ones with an open assignment to a *different* person — appears
in the dropdown with no indication (`{a.name} ({a.tag})`, no current-holder
label). Picking one silently reassigns it away from its current holder (AC-5
does permit this, that part is correct), but there's no signal or confirmation
that this is a reassignment rather than a pool pickup.

**Why it matters**: An admin working from a person's page (rather than the
device's page, where the current assignee is visible) has no way to tell they're
about to take a device from a coworker until after the fact.

**Suggested fix**: Either filter `pickable` to unassigned devices only (simplest,
if reassignment-from-the-person-page isn't a needed workflow), or annotate each
already-held option with its current holder's name so the admin can make an
informed choice.

### 🟡 Sequential per-device update loop inside `archivePerson`'s transaction, `web/src/db/people.ts:376-381`

**Problem**: After closing a person's open assignments, `archivePerson` loops
`for (const c of closed) { await tx.update(assets)... }`, issuing one `UPDATE`
per device instead of a single `update(assets).set({assigneeId: null}).where(inArray(assets.id, ids))`.

**Why it matters**: Harmless at current fleet scale (a person rarely holds more
than a handful of devices), but it's an N+1 pattern inside a transaction that
will get slower as it's copy-pasted elsewhere.

**Suggested fix**: Batch with `inArray(assets.id, closed.map(c => c.assetId))`.

### 🟡 `Field` and `fmtDateTime` are re-implemented in both detail components

**Problem**: `web/src/components/asset-detail.tsx` (`fmt`/`fmtDateTime` at
`:88-110`, `Field` at `:131-141`) and `web/src/components/person-detail.tsx`
(`fmtDateTime` at `:55-66`, `Field` at `:68-79`) each define near-identical
label/value and date-formatting helpers.

**Why it matters**: Two parallel implementations of the same small pieces of UI
will drift (already: asset-detail's `fmtDateTime` omits the year,
person-detail's includes it) and cost double the maintenance the next time
either changes.

**Suggested fix**: Factor `Field` and the date formatters into a shared module
(e.g. `src/components/ui/field.tsx`, `src/lib/format.ts`) the next time either
file is touched; not worth a standalone change today.

### 🟡 Directory search doesn't escape LIKE wildcards, `web/src/db/people.ts:97-108`

**Problem**: `getDirectoryPeople`'s search term is wrapped in `%${term}%` and
passed straight into `lower(...) like ${like}`. A search containing `%` or `_`
is interpreted as a SQL wildcard rather than a literal character.

**Why it matters**: Not a security issue (fully parameterized), just a
correctness/UX edge case — searching for a name or department that happens to
contain `_` or `%` matches more broadly than intended.

**Suggested fix**: Escape `%`/`_`/`\` in the search term before interpolating,
or use a `ilike`-safe helper if one already exists elsewhere in the codebase.

## Strengths

- The assignment engine's core design is exactly right: one transactional
  "close-open-sync" sequence, shared between the standalone `assignAsset`/
  `returnAsset` and the `Tx`-scoped `assignAssetTx`/`returnAssetTx` used inside
  the asset form's own transaction, backed by the DB-level partial unique index.
  The comments in `schema.ts` and `assignments.ts` clearly explain *why*
  `assigneeId` is never written outside the engine, which is exactly the kind of
  self-documenting guardrail this invariant needs.
- `people.ts`'s uniqueness handling (pre-check plus a `23505` race catch that
  distinguishes email vs. employee-id by constraint name) is careful, well
  commented, and has a matching unit test for the race itself — a good model
  the assignment engine's own race handling (see Major above) should have
  followed.

## Test coverage

Well covered: `assignments.test.ts` and `people.test.ts` thoroughly exercise the
engine's transitions (assign/reassign/no-op/archived-refuse/return) and the
people lifecycle (create/update/archive/delete, including the uniqueness race)
against faithful fake-transaction mocks. `people-actions.test.ts` covers the
`asset:write` gate for every mutation plus the tag-resolution and error-mapping
paths. `people-directory.test.tsx` and `person-form-dialog.test.tsx` cover their
components' render, search, pagination, write-gating, and validation.

Not covered, despite appearing to be: the `assets/actions.ts` reroute through
`assignAssetTx`/`returnAssetTx` (Major above — `actions.test.ts` wasn't updated
for spec 16 and its "assignee deleted" tests no longer reach the new code).
Not covered at all: `person-detail.tsx` (Major above — no test file), the new
assign/return controls and `isAssignable` gating added to `asset-detail.tsx`
(only the empty-history-state render is asserted), and the concurrent-assign
race in the engine (no equivalent of `people.test.ts`'s 23505-race test exists
for `assignAssetTx`).
