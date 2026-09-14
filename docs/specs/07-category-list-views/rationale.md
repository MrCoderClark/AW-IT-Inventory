# Rationale — 07. Category list views + asset detail page

## Context

At the end of the discovered-devices inbox work (spec 06), the five asset category
pages were still `PagePlaceholder` stubs (`web/src/app/(app)/{computers,monitors,
printers,phones,network}/page.tsx`). The app already has everything needed to make them
real:

- `AssetTable` (`web/src/components/asset-table.tsx`) — a TanStack v8 client table with
  search, a type filter, a status filter, sorting, and client-side pagination
  (pageSize 8). Its row-click and row-menu "View details" push `?asset=<tag>`, which
  the dashboard's `AssetDetailDrawer` reads to open a side sheet.
- `getAssets()` / `getMachineSummaries()` (`web/src/db/queries.ts`) — the read layer.
  Note the UI `Asset.id` is the asset **tag** (e.g. `OPUS-COMP-7491`), not the uuid.
- `AssetDetailDrawer` (`web/src/components/asset-detail-drawer.tsx`) — renders the full
  detail (metadata grid, live-scan panel, audit timeline, placeholder actions) inside a
  `Sheet`, driven by the `?asset=` search param.
- The `asset:read` permission already exists in the aw-auth RBAC seed; `/scans` shows
  the server-side gate pattern (`requireUser` + `hasPermission`).

The user made three decisions up front: (1) one shared, config-driven table across all
five categories; (2) read-only first (create/edit deferred to a later Add/Edit form);
(3) row-click opens a **detail page, not a drawer** — the user dislikes side-drawer
detail UIs and wants one consistent page-based pattern.

## Options considered

### The table

**A. One shared config-driven table (chosen).** Refactor `AssetTable` to take a config
(columns + type-filter visibility + empty message); category pages pass a per-type
column set with the type filter hidden, the dashboard passes the all-types set.
- Pros: one component to maintain, consistent behavior, matches the user's explicit
  choice, small diff (the table already does the hard parts).
- Cons: a config object adds a little indirection; column sets must stay coherent.

**B. Per-category tables.** Each page owns its own table component.
- Pros: total freedom to diverge per type.
- Cons: five near-duplicates to keep in sync; the user rejected this.

### The detail view

**C. Dedicated `/assets/[id]` page + retire the drawer (chosen).** One canonical detail
route; repoint the dashboard row-click and the ⌘K palette to it; remove the drawer.
- Pros: linkable, refresh-safe, back-button friendly; one detail pattern app-wide;
  matches the user's preference against drawers.
- Cons: touches the dashboard and palette; needs care not to regress the all-types
  table and deep-links.

**D. Keep the drawer, add a page too.** Category rows open a page, dashboard keeps the
drawer.
- Pros: smallest change to the dashboard.
- Cons: two competing detail UIs — exactly what the user wants to avoid.

**E. `/[category]/[id]` nested detail route.** Detail lives under each category.
- Pros: URL encodes the category.
- Cons: five duplicate detail routes, or a shared component mounted five times; a single
  `/assets/[id]` is simpler and the asset tag is already globally unique.

### The detail route id

The UI `Asset.id` is the asset **tag**, which is human-readable and globally unique, and
is the exact value the drawer's `?asset=` already used. Using it as the route segment
(`/assets/OPUS-COMP-7491`) keeps links readable and avoids exposing the uuid. Unknown
tags resolve to `notFound()`.

### Pagination

Kept **client-side**, as the current table already does. The fleet target is ~100+
machines (low hundreds of assets), well within a single client-side page load.
Server-side pagination is noted as a follow-up if any one category grows very large.

## Rationale

Options A and C together are the smallest change that delivers exactly what the user
asked for: one shared table, page-based detail, one pattern. The existing `AssetTable`
already implements search/sort/filter/pagination, so the refactor is mostly extracting
a config and swapping the row-navigation target. The drawer's render logic transfers
almost directly into a page body, so the detail page is low-risk. Retiring the drawer
(rather than keeping both) is the whole point — it removes the pattern the user dislikes
and leaves one way to view an asset.

## References

Project sources:
- `docs/specs/05-frontend-spec.md` — frontend conventions (Server Actions for writes,
  RSC queries for reads, permission gating).
- `docs/specs/03-inventory-data-model.md` — the `assets`/`machines`/`people` model.
- `web/src/components/asset-table.tsx`, `web/src/components/asset-detail-drawer.tsx`,
  `web/src/db/queries.ts`, `web/src/app/(app)/scans/page.tsx` — the patterns reused.
