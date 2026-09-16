# Verify: category list views + asset detail page · spec 07 · 2026-09-14

_Steps derived from spec 07 acceptance criteria. `/check verify` runs these; `/test`
locks the durable ones._

## Commands
- [ ] `cd web && npx tsc --noEmit` (or `npm run build`) → typechecks clean → all
- [ ] `grep -r "asset=" web/src` → no remaining code path opens a drawer via the
  `?asset=` param (dashboard + palette repointed) → AC-5

## UI / manual (signed in as a user with `asset:read`)
- [ ] Visit `/computers` → a real table lists **only** Computer assets; `/monitors`,
  `/printers`, `/phones`, `/network` each list only their own type → AC-1
- [ ] On a category page: search filters rows, the status filter works, column headers
  sort, the pager pages; the **asset-type** filter is not shown (already scoped) → AC-2
- [ ] A category with no assets shows a clear empty state (temporarily filter to prove,
  or check an empty type) → AC-1
- [ ] Click a row → the browser navigates to `/assets/<tag>` (URL changes to a real
  page), not a drawer; the row menu "View details" does the same → AC-3
- [ ] On `/assets/<tag>`: header (type, name, copyable id, status), metadata grid
  (model, spec, assignee, location, purchase date, warranty, vendor, cost center),
  live-scan panel for a Computer/Printer (or when machine data exists), audit timeline,
  and the placeholder actions all render; refresh the page → it still renders → AC-4
- [ ] Visit `/assets/DOES-NOT-EXIST` directly → a 404 / not-found page, not a crash → AC-7
- [ ] On `/dashboard`: click a table row → navigates to `/assets/<tag>` (no drawer);
  open ⌘K, pick an asset → navigates to `/assets/<tag>` (not `/dashboard?asset=`);
  the dashboard KPIs, charts, and all-types table (with its type filter) still work → AC-5, AC-8

## Permissions
- [ ] Sign in as a user **without** `asset:read` → each category page and `/assets/<tag>`
  show the "you don't have permission" message instead of the table/detail → AC-6

## Acceptance-criteria coverage
- AC-1 … real per-type tables + empty state (UI steps 1, 3)
- AC-2 … shared config-driven table; search/status/sort/pager; type filter hidden (UI step 2)
- AC-3 … row + menu navigate to `/assets/[id]` (UI step 4)
- AC-4 … detail page renders full content, refresh-safe (UI step 5)
- AC-5 … drawer retired; dashboard + palette repointed (command 2, UI step "dashboard")
- AC-6 … `asset:read` gate on category + detail pages (Permissions step)
- AC-7 … unknown tag → notFound (UI step 6)
- AC-8 … dashboard no-regression; Software out of scope (UI step "dashboard")
