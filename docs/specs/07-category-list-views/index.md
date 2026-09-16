# 07. Category list views + asset detail page

**Date**: 2026-09-14
**Status**: Accepted

> Decision history (Context, Options considered, Rationale) lives in
> [rationale.md](./rationale.md). Verification steps in [verify.md](./verify.md).

## Summary

The five asset category pages (`/computers`, `/monitors`, `/printers`, `/phones`,
`/network`) are still `PagePlaceholder` stubs. This spec replaces them with real,
read-only list tables driven by **one shared, config-driven table component**, each
page scoped to a single asset type. Clicking a row opens a **dedicated asset detail
page** at `/assets/[id]` (not the side drawer). The existing side drawer
(`AssetDetailDrawer`) is retired: the dashboard row-click and the ⌘K palette are
repointed to the detail page, so the app has exactly one detail pattern. No schema
change; reuse the existing `assets`/`machines` tables, the TanStack v8 table, and the
`/api/assets` data layer. Create/edit stays out of scope (a later Add/Edit form).

## Requirements

**User stories**:
- As an IT admin, I want a real table for each asset category, so I can browse,
  search, sort, and filter the fleet by type instead of hitting a placeholder.
- As an IT admin, I want to open an asset's full details on its own page, so I can
  link to it, refresh it, and use the back button — not a drawer that vanishes.
- As the team, we want one consistent way to view an asset's detail across the app.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: Each of `/computers`, `/monitors`, `/printers`, `/phones`, `/network`
  renders a real table listing **only** that asset type's assets (filtered by
  `AssetType`), replacing the placeholder. An empty category shows a clear empty state.
- **AC-2**: All five pages use a single shared, config-driven table component. The
  per-category config sets the visible columns; the page title/type is derived from
  the route. The redundant asset-type filter is hidden on category pages (already
  scoped to one type); search, status filter, column sorting, and pagination all work.
- **AC-3**: Clicking a table row (and the row menu's "View details") navigates to
  `/assets/[id]` (a real page), where `id` is the asset tag (e.g. `OPUS-COMP-7491`).
  No navigation anywhere opens the side drawer.
- **AC-4**: `/assets/[id]` renders the full asset detail as a page: header (type,
  name, copyable id, status badge); metadata grid (model, spec, assignee, location,
  purchase date, warranty until, vendor, cost center); the live-scan panel for
  Computer/Printer or when machine data exists; the audit timeline; and the existing
  (placeholder) actions. It is reachable directly by URL and survives refresh.
- **AC-5**: The side drawer is removed. `AssetDetailDrawer` is no longer mounted on
  the dashboard (or anywhere), the `?asset=` URL param no longer opens a drawer, the
  dashboard table row-click goes to `/assets/[id]`, and the ⌘K palette asset items go
  to `/assets/[id]` instead of `/dashboard?asset=`.
- **AC-6**: Every category page and the detail page are gated server-side on
  `asset:read` (mirroring the `/scans` `scan:read` pattern with `requireUser` +
  `hasPermission`); a user without it sees the permission message, not the table/detail.
- **AC-7**: `/assets/[id]` with an unknown or nonexistent tag returns Next's
  `notFound()` (a 404 page), never a crash or a blank shell.
- **AC-8**: No regression: the dashboard (KPIs, charts, all-assets table with its type
  filter) keeps working after the refactor. `Software` is explicitly out of scope and
  stays a placeholder (it is not an `AssetType`).

## Decision

**Chosen option**: one shared config-driven `AssetTable` + a canonical `/assets/[id]`
detail page; retire the drawer.

- **Table**: refactor the existing `AssetTable` to accept a small config
  (`{ columns, showTypeFilter, title, emptyMessage }`) instead of a hardcoded column
  set and toolbar. Category pages pass a per-type column config with the type filter
  hidden; the dashboard passes the all-types config with the type filter shown. Row
  navigation changes from `router.push(?asset=...)` (drawer) to
  `router.push('/assets/'+id)`.
- **Detail page**: a new server component at
  `web/src/app/(app)/assets/[id]/page.tsx` that reuses the drawer's rendering as page
  content (metadata grid, live-scan panel, audit timeline, placeholder actions),
  gated on `asset:read`, `notFound()` on unknown id.
- **Drawer retirement**: delete the `AssetDetailDrawer` mount + `?asset=` handling
  from the dashboard, repoint the palette, and remove the now-unused component.

Alternatives (per-category tables; keep the drawer; a `/[category]/[id]` route)
are weighed in [rationale.md](./rationale.md).

## Feature design

**Data model**: no schema change. Reuse `assets`, `machines`, `people`.

**Data layer** (`web/src/db/queries.ts`):
- `getAssetsByType(type: AssetType): Promise<Asset[]>` — the existing `getAssets`
  select with `where(eq(assets.type, type))`. (Or reuse `getAssets()` and filter in the
  page; a focused query is preferred and trivial.)
- `getAssetById(id: string): Promise<Asset | null>` — select one asset by `tag`
  (the UI `id`), joined to `people`, mapped through the existing `toAsset`.
- `getMachineSummary(id: string): Promise<MachineSummary | undefined>` — the one
  machine summary for a tag (reuse the `getMachineSummaries` mapping, scoped to one).

**Routes / surfaces**:

| Surface | Kind | Auth | Notes |
|---|---|---|---|
| `/computers` `/monitors` `/printers` `/phones` `/network` | RSC page | `asset:read` | shared table, filtered to one `AssetType` |
| `/assets/[id]` | RSC page | `asset:read` | full detail; `notFound()` on unknown tag |
| `/dashboard` | RSC page (changed) | (unchanged) | drawer removed; table row-click → `/assets/[id]` |
| ⌘K palette | client (changed) | — | asset items → `/assets/[id]` |

**Shared table config** (client component `AssetTable`):

```ts
type AssetTableConfig = {
  columns: ColumnDef<Asset>[];   // per-category / all-types column set
  showTypeFilter?: boolean;      // dashboard: true; category pages: false
  title?: string;                // optional heading
  emptyMessage?: string;         // e.g. "No monitors yet."
};
```

Column sets live beside the component (e.g. a `columnsFor(type)` helper). Categories
drop columns that don't apply (e.g. `assignee` is meaningful for phones/computers,
less so for network gear) — kept pragmatic, not over-engineered.

**Per-category column guidance** (starting point, refine in build):
- Computers: id, name, model, serial, assignee, location, status, lastSync, actions
- Monitors: id, name, model, serial, assignee, location, status, actions
- Printers: id, name, model, serial, location, status, lastSync, actions
- Phones: id, name, model, serial, assignee, location, status, actions
- Network: id, name, model, serial, location, status, actions

**Key invariants**:
- The UI `Asset.id` is the asset **tag** (human key), the same value the drawer's
  `?asset=` used; the detail route uses it verbatim (`/assets/OPUS-COMP-7491`).
- The shared table must keep the dashboard's all-types behavior intact (type filter
  visible, all rows), so the refactor is additive, not a dashboard regression.
- Pagination stays **client-side** (the fleet is ~100s of assets; the page loads the
  category's rows and paginates in the browser, as the current table does).

**Security model**: pages gate on `asset:read` server-side via `requireUser` +
`hasPermission`, exactly like `/scans` gates on `scan:read`. The detail page applies
the same gate before rendering. No new permissions; `asset:read` already exists in the
RBAC seed.

**Configuration required**: none. No new env vars, no migration.

## Build plan

Built as a thin end-to-end thread first (Tracer Bullet; no approach is recorded for
this project, so the default is end-to-end slices), then widened.

1. **Data layer**: add `getAssetsByType`, `getAssetById`, `getMachineSummary` in
   `db/queries.ts`. Satisfies groundwork for AC-1, AC-4.
2. **Detail page (thin thread)**: build `/assets/[id]` as a page rendering the
   drawer's content, gated on `asset:read`, `notFound()` on unknown id. Satisfies
   AC-4, AC-7 (and the detail half of AC-6).
3. **Shared table refactor**: make `AssetTable` config-driven (columns, type-filter
   visibility, empty message); switch row navigation to `/assets/[id]`; keep the
   dashboard working with the all-types config. Satisfies AC-2, AC-3, AC-8 (dashboard).
4. **Category pages**: replace the five placeholders with the shared table filtered by
   type, each gated on `asset:read`, each with an empty state. Satisfies AC-1, AC-6.
5. **Retire the drawer**: remove `AssetDetailDrawer` mount + `?asset=` from the
   dashboard, repoint the ⌘K palette to `/assets/[id]`, delete the unused component.
   Satisfies AC-5.
6. **Polish**: empty/loading states, back-navigation, and a `verify.md` pass.

## Consequences

**Positive**:
- Five placeholder pages become real, consistent inventory views with one component to
  maintain.
- Detail views are now linkable, refresh-safe, and back-button friendly (a page, not a
  drawer) — the UX the user asked for, and one pattern app-wide.
- Sets up the later Add/Edit asset form (the detail page is where Edit will live) and
  category-specific columns.

**Negative / tradeoffs**:
- Retiring the drawer touches the dashboard and palette; a careful refactor is needed
  so the dashboard's all-types table and deep-links don't regress.
- Client-side pagination loads a whole category at once; fine at ~100s, revisit if the
  fleet grows into many thousands (server-side pagination is the later path).
- Per-category column configs add a little surface to keep coherent.

**Neutral**:
- `Software` and other non-asset nav items are untouched.
- Reconciliation, ingest, and the discovered-devices inbox are unaffected.

## Follow-up

- [ ] Add/Edit asset form (backlog): wire real Edit/Reassign on the detail page,
      replacing the placeholder toasts.
- [ ] Server-side pagination/filtering if a single category grows very large.
- [ ] `Software` page: needs its own data model (installed software), tracked separately.
- [ ] Consider a per-category live-health column for Computers/Printers using the
      machine summaries.

## Rationale

See [rationale.md](./rationale.md) for the options considered and why this shape was
chosen.
