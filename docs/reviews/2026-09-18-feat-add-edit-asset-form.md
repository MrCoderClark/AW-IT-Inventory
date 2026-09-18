# Review, feat/add-edit-asset-form, 2026-09-18

**Reviewed by**: Claude Sonnet 5 (author on Claude Opus 4.8)
**Scope**: 22 files (excl. package-lock.json), branch vs `main` (merge base `9314018` → tip `da19eaf`)
**Verdict**: Approve with nits

## Summary

This spec adds manual asset CRUD to OPUS: three `asset:write`-gated Server Actions (`createAsset`/`updateAsset`/`deleteAsset`) that mirror `scans/actions.ts` exactly, one shared zod schema (`lib/asset-schema.ts`) parsed on both the client and the server trust boundary, and a single `AssetFormDialog` reused for create and edit. The tag-generation helper was cleanly extracted to `lib/tags.ts` and both create paths (`assets/actions.ts`, `scans/actions.ts`) now import the one definition, closing the AC-8 divergence risk. I verified this by grep: `generateTag`/`TAG_PREFIX` have exactly one definition and two importers. The implementation is careful and consistent with the codebase's established patterns — `ActionResult`, `requireWrite()`, `revalidatePath`, `useTransition` + `sonner` — and the shared zod schema is well exercised by tests (required fields, blank→null coercion, the date cross-check, assignee UUID validation). I hand-verified the schema's behavior against a live zod v4 instance (enum error messages, refine path attachment) and it behaves as documented. No blockers or majors that would cause incorrect behavior in production; the issues below are a real test-coverage gap on the write-gate UI wiring and a couple of minor resilience/nit items.

## Major

### 🟠 `AssetTable`'s write-gate wiring (New asset button + `presetType`) has zero test coverage, `web/src/components/asset-table.test.tsx`

**Problem**: `asset-table.tsx` was changed to accept `canWrite` and `people` props, conditionally render the "New asset" button (`canWrite && ...`), and wire `AssetFormDialog` with `presetType={type}` from the page's category config (the mechanism AC-1 depends on for "Type is pre-selected" on a category page). The corresponding test file was touched in this diff — but only to add a mock for the new server-action import chain (`vi.mock("@/app/(app)/assets/actions", ...)`); every existing test still calls the local `renderTable()` helper, which never passes `canWrite` or `people`. There is no test in this file (or anywhere) asserting: (a) the "New asset" button is hidden when `canWrite` is false (default), (b) it appears and opens the dialog when `canWrite` is true, or (c) `presetType` is correctly derived from `config.type` on a category page vs. left unset on the dashboard.
**Why it matters**: `canWrite` is a security-relevant branch (it is the client-side half of the AC-6 write gate) and it is the one acceptance path (AC-1) that ties a category page's type to the pre-filled dialog. The guide's own bar for `TESTS = configured` is that branching, auth-relevant logic without a test is at least Major. The server action still independently enforces `asset:write` (so a regression here would not actually expose a write path to an unauthorized user), but a refactor that silently drops the `canWrite &&` guard, or that stops threading `type` through to `presetType`, would ship undetected — the exact scenario `/check verify`'s note flagged as only-covered-in-theory for AC-6.
**Suggested fix**: Add a couple of cases to `asset-table.test.tsx`: render with `canWrite={true}` and assert the "New asset" button exists and clicking it surfaces the dialog title/preset type; render with the default (`canWrite` unset) and assert the button is absent; render with `config.type = "Monitor"` and `canWrite` true and assert the dialog shows Monitor pre-selected (the same assertion style already used in `asset-form-dialog.test.tsx`, just exercised through `AssetTable`'s own prop-threading).

## Minor

### 🟡 A concurrently-deleted assignee crashes the write action instead of returning a clean error, `web/src/app/(app)/assets/actions.ts:62` and `:107`

**Problem**: `assigneeId` is validated by the zod schema only as "well-formed UUID or null" (`lib/asset-schema.ts`'s `nullableAssignee`) — it never checks the person still exists. `assets.assigneeId` is a real FK to `people(id)` (`web/src/db/schema.ts:39-41`, `onDelete: "set null"` only applies when the *referenced* row is deleted, not when an *invalid/stale* id is inserted). If a person is deleted between the moment the edit/create dialog is opened (loaded via `getPeople()`) and the moment the form is submitted, `db.insert(assets)...` / `db.update(assets)...` will throw a raw Postgres FK-violation error that propagates uncaught out of the Server Action, rather than the "clean error, never a crash" standard the spec sets for AC-7 (which is explicitly about a missing *asset*, but the same resilience bar reads naturally onto a missing *assignee*).
**Why it matters**: For a small trusted admin team this is a narrow race window, but when it does hit, the admin sees Next.js's generic server-error UI instead of an actionable message, and — worse — for `createAsset` it happens *after* a tag was already reserved via `onConflictDoNothing`/`returning` in the same statement, so debugging "why did my asset half-appear" is harder than it needs to be.
**Suggested fix**: Either catch the FK-violation (Postgres error code `23503`) around the insert/update and return `{ ok: false, error: "That assignee no longer exists. Refresh and try again." }`, or re-validate `assigneeId` against `people` inside the same flow before writing (cheap, since `getPeople()` is already the source of truth the form used).

## Nits

- ⚪ `web/src/components/asset-form-dialog.tsx:221`, the "Available (unassigned)" option is modeled as `<SelectItem value="">`. It works (Base UI doesn't special-case empty string the way Radix does), but Base UI's own docs recommend a `value={null}` sentinel item for a clearable selection, not `""` — worth a comment so a future contributor doesn't copy `value=""` into a select where it *would* collide with a real empty-string domain value.
- ⚪ `web/package.json:44`, `@types/node` jumps `^20` → `^22.20.3` in the same commit as adding `zod`; unrelated to this feature and not mentioned in the spec's Consequences — probably an incidental `npm install` side effect, worth a one-line note in the PR description so it doesn't look accidental.
- ⚪ `getPeople()` is now called independently from 7 different page loads (5 category pages + dashboard + `/assets/[id]`) whenever `canWrite` is true, each a fresh round trip for the same small table. Fine at this fleet's scale; a `React.cache()`-wrapped query would dedupe it per-request if it's ever noticeable.

## Strengths

- The tag-helper extraction is exactly as prescribed: one definition in `lib/tags.ts`, two importers (`assets/actions.ts`, `scans/actions.ts`), verified by grep and locked in by `lib/tags.test.ts`'s cross-checks against `ASSET_TYPES`.
- The shared zod schema is genuinely well designed for the defense-in-depth goal: blank→null coercion, a `>=` date cross-check with the error correctly attached to `warrantyUntil` (verified independently), and a UUID-checked assignee — all backed by thorough, well-named tests in `asset-schema.test.ts`.
- `createAsset`'s tag-collision retry (`onConflictDoNothing` + up to 6 attempts) mirrors the existing `createAssetFromDevice` pattern faithfully and is precisely tested (`toHaveBeenCalledTimes(6)` on exhaustion, and the two-attempt retry-then-succeed path).
- `type` is correctly excluded from `updateAsset`'s `.set()` payload (verified by a dedicated test asserting `setPayload` has no `type` key), keeping the tag-prefix/type invariant intact on edit.
- The delete confirmation is a real in-app `Dialog`, never `window.confirm` (verified by grep across `src`), with a disabled/loading state during the transition.
- `AssetDetail`/`AssetTable` default `canWrite`/`people`/`assigneeId` to safe values (`false`/`[]`/`null`), so the components degrade cleanly wherever a caller doesn't thread them through.
- The pre-existing `fmt()` null/`Invalid Date` guard is included in this diff and is covered by a dedicated regression test.

## Test coverage

Well covered: the zod schema (required fields, trimming, blank→null, date cross-check, assignee UUID), the tag helper (prefix-per-type, shape, collision entropy), all three Server Actions (happy path, forbidden, invalid input, "no longer exists", the type-locked update, the inbox-revalidation on delete), and `AssetFormDialog` itself (create pre-select, validation errors, edit pre-fill, locked type/tag, success/failure paths). `AssetDetail`'s new write-gated Edit/Delete controls are tested for both the with- and without-`asset:write` cases.

Gap: as detailed above, `AssetTable`'s own threading of `canWrite`/`presetType` into the "New asset" button and dialog is untested — the file was touched only to add a boundary mock, not new assertions. Also untested (lower priority, noted as Minor above): the FK-violation path when `assigneeId` points at a since-deleted person.
