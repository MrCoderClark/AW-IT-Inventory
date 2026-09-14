# Review, feat/category-list-views, 2026-09-14

**Reviewed by**: Claude Sonnet 5 (author on Claude Opus)
**Scope**: 14 files (excl. package-lock.json), branch vs `main` (merge base `5ca15d6`) + uncommitted working tree
**Verdict**: Approve with nits

## Summary

This implements spec 07 end-to-end: five category pages get a real, config-driven `AssetTable`, a new `/assets/[id]` detail page replaces the side drawer, and the drawer plus its `?asset=` param are fully retired (dashboard and ⌘K palette repointed). The serializable-config refactor (`type` string + client-side `columnsFor(type)`) is exactly right for the RSC/client boundary problem it's solving, the `asset:read` gate mirrors the `/scans` pattern precisely on all six pages, and `notFound()` fires correctly for unknown tags. `tsc --noEmit` is clean and all 20 new Vitest tests pass. The one real inefficiency is `getMachineSummary`, which loads and deserializes every machine row in the fleet just to pick one — correct today, but the wrong shape for a query that spec explicitly called out as its own function. A few smaller UX/consistency gaps (hardcoded "back" target, unencoded palette href, no `npm test` script) round out the findings; none of them block merge.

## Major

### 🟠 `getMachineSummary` does a full-fleet scan to return one row, `web/src/db/queries.ts:114-119`
**Problem**: `getMachineSummary(id)` calls `getMachineSummaries()` — which joins `machines` to `assets` with no `WHERE` clause, fetches every machine in the fleet, and JSON-parses each one's `hardware`/`health` blobs — then throws away every entry except the one matching `id`. This runs on every single `/assets/[id]` page view (`web/src/app/(app)/assets/[id]/page.tsx:60`), not just occasionally.
**Why it matters**: The spec (`docs/specs/07-category-list-views/index.md:90-91`) explicitly asked for this as "the one machine summary for a tag," i.e. a scoped query — this instead does the unscoped one and filters client-side in Node. At today's fleet size (~100s of machines) the cost is small, but it's an unbounded-per-request read that scales with total fleet size rather than with the single row requested, and the correct version is a one-line change away (add `.where(eq(assets.tag, id))` to the join, or reuse `assetSelect`-style filtering). This is exactly the kind of "redundant DB call" pattern that's cheap to fix now and easy to forget once other pages start reusing this helper.
**Suggested fix**: Give `getMachineSummary` its own scoped query (`where(eq(assets.tag, id))`, `limit(1)`) instead of delegating to `getMachineSummaries()`. If de-duplicating the row-mapping logic is a concern, factor the per-row mapping (the `hw`/`health` extraction block) into a shared helper both functions call, rather than sharing the query itself.

## Minor

### 🟡 "Back to inventory" always targets `/dashboard`, `web/src/components/asset-detail.tsx:665-672`
**Problem**: The detail page's back link is hardcoded to `/dashboard` regardless of where the user came from. A user who navigated from `/printers` → a printer's detail page and clicks "Back to inventory" lands on the dashboard, not `/printers`.
**Why it matters**: Contradicts the spec's own framing of this page as "linkable, refresh-safe, and back-button friendly" — the browser back button does the right thing, but the page's own affordance doesn't. Minor but a real inconsistency an IT admin bouncing between category pages will notice.
**Suggested fix**: Either drop the explicit link and rely on browser back, or make it `router.back()` with a `/dashboard` fallback (e.g. via `document.referrer` or a `from` query param set by the table's row navigation).

### 🟡 New data-layer functions have no test coverage, `web/src/db/queries.ts:91-119`
**Problem**: `getAssetsByType`, `getAssetById`, and `getMachineSummary` are new logic with no corresponding tests (the two new test files cover only `AssetTable` and `AssetDetail`).
**Why it matters**: Per the test signal for this branch (`configured`), new logic without coverage is at least a Minor — and this is exactly the function (`getMachineSummary`) with the correctness/perf issue flagged above. A test wired against a fixture DB (or a thin mapping-logic unit test extracted from the query) would have made the inefficiency visible earlier.
**Suggested fix**: Out of scope for this reviewer to write (that's `/test`'s job), but worth a follow-up: at minimum, unit-test the row-mapping logic inside `getMachineSummaries`/`getMachineSummary` independent of the DB call.

### 🟡 No `npm test`/`npm run test` script, `web/package.json:5-15`
**Problem**: Vitest, jsdom, and Testing Library are added as devDependencies and a suite exists, but `package.json`'s `scripts` block has no `test` entry — `npx vitest run` is the only way to invoke it.
**Why it matters**: Every other tool in this repo (`db:push`, `db:seed`, etc.) is wired as an `npm run` script per the project's "Run it" convention in `CLAUDE.md`; the test runner is the odd one out and anyone following that convention won't find it.
**Suggested fix**: Add `"test": "vitest run"` (and optionally `"test:watch": "vitest"`) to `web/package.json` scripts.

## Nits

- ⚪ `web/src/components/command-palette.tsx:102`: `go(\`/assets/${a.id}\`)` doesn't `encodeURIComponent(a.id)` the way `asset-table.tsx:348` does for the same navigation. Harmless today since tags are `[A-Z0-9-]+`, but the two call sites should match.
- ⚪ `web/src/app/(app)/assets/[id]/page.tsx:57-60`: `getAssetById` and `getMachineSummary` run sequentially even though the second doesn't depend on the first's result (both key off the same route `id`/tag). Could be `Promise.all`'d to save one round trip on every detail-page view.
- ⚪ `web/src/db/queries.ts`: `getAssetsByType` and `getAssetById` duplicate the `assetSelect`/join/`toAsset` boilerplate from `getAssets` three times over now. Not urgent at this size, but a shared `queryAssets(where?)` helper would remove the repetition if a fourth variant shows up.

## Strengths

- The `type?: AssetType` + `columnsFor(type)` split in `asset-table.tsx` is the right fix for the RSC→client function-serialization problem, and it's applied consistently across all five category pages and the dashboard — no page passes a raw `ColumnDef[]` across the boundary.
- The `showTypeFilter` guard (`asset-table.tsx:375-377`) correctly avoids calling `table.getColumn("type")` when that column doesn't exist in the scoped views, with a clear comment explaining why (avoids a TanStack console warning) — an easy thing to get subtly wrong.
- Drawer retirement is clean and complete: no leftover `?asset=` references, no leftover `AssetDetailDrawer` imports, and the `Sheet` UI primitive it used is still legitimately used elsewhere (`top-bar.tsx`), so nothing was over-deleted.
- All six gated pages (`computers`, `monitors`, `network`, `phones`, `printers`, `assets/[id]`) use the exact `requireUser()` + `hasPermission(user, "asset:read")` + `PagePlaceholder` shape as `/scans`, byte-for-byte consistent.
- Tests are behavioral, not incidental: they assert on rendered column headers/filter counts per category (AC-2), row-click navigation target via a mocked `router.push` (AC-3), and empty-state text (AC-1) — not implementation details.

## Test coverage

`asset-table.test.tsx` (11 tests) and `asset-detail.test.tsx` (9 tests) — 20 total, all passing — cover: per-category column sets and Type-column omission (AC-2), type/status filter visibility (AC-2), empty-state fallback and custom message (AC-1), search filtering (AC-2), row-click navigation to `/assets/<tag>` (AC-3), and the full detail page render — header, metadata grid, live-scan panel (present/absent/with-data), audit timeline, and action buttons (AC-4). Not covered: the row menu's "View details" item (only the row-click path is tested), the `/assets/[id]/page.tsx` RSC wrapper itself (permission gate, `notFound()` on unknown tag — reasonable to leave untested given it requires a DB), and the three new `queries.ts` functions (also DB-backed, but `getMachineSummary`'s behavior is exactly what should have caught the full-scan issue above). `tsc --noEmit` and the full Vitest suite (20/20) both pass as of this review.
