# 11. Global table column configuration, rationale

Decision record for [index.md](./index.md). This is the reasoning and the options
weighed; `/develop` does not need it.

## Context

The asset tables are the core of the app. Spec 07 made them config-driven: one
shared `AssetTable` component picks its columns from `columnsFor(type)` for the
five category pages and `allColumns` for the mixed dashboard and location pages.
Spec 10 added per-type detail tables and surfaced three identifier fields (IP,
MAC, phone number) as extra columns on the relevant category pages, and left an
explicit follow-up: show more type-specific fields as columns per list.

The column choices are hardcoded. Which columns a team wants varies by site and by
how they run their fleet, and there is no way to change them without editing
`asset-table.tsx` and redeploying. The team wants an admin to choose the columns
once, shared by everyone, across the five category pages, the dashboard, and the
location device pages.

Three forces shape the decision. First, the tables already work well and are
heavily used, so the change must not regress search, filters, sorting, pagination,
or row navigation, and must be inert until an admin opts in. Second, the app runs
two deployables with a real permission boundary: web owns `aw_it_inventory` and
aw-auth owns roles and permissions, so any new permission is a cross-service
change. Third, columns carry JSX cell renderers, and the pages are React Server
Components while the table is a client component, so whatever is persisted must be
serializable and the actual column definitions must stay on the client.

Not deciding leaves the follow-up from spec 10 open and keeps every column change a
code edit and redeploy, which does not scale to a tool meant to be run by IT staff.

## Options considered

### Option 1: Fix in place, global saved layout as an explicit ordered id list (chosen)

Keep the existing `AssetTable` and its column definitions. Add stable ids, a
code-owned catalog and defaults, and one `table_column_config` row per view holding
the chosen ordered ids. Render the saved list when present, otherwise the code
defaults.

**Pros**:
- Smallest change to a working component; the risky part (column rendering) is
  untouched, only the selection becomes data-driven.
- WYSIWYG for the admin: the saved list is exactly what shows, in order.
- Serializable (ids only), so it crosses the server/client boundary cleanly and
  tolerates a removed or renamed column by filtering through the catalog.
- Inert until used: no row means the exact current table.

**Cons**:
- A newly added code column is not shown automatically; an admin must add it.
- Storing the full list (not a delta) means the saved layout does not track future
  default changes; acceptable, since the admin has taken ownership of that view.

### Option 2: Save only the overrides (a delta on the defaults)

Store added and removed ids (and an optional order) rather than the full list.
Render = defaults plus added minus removed.

**Pros**:
- New code columns appear automatically unless explicitly removed.
- Smaller stored payload.

**Cons**:
- The merge is harder to reason about and to show accurately in the picker (the
  effective list depends on the current code defaults, which can move under the
  admin).
- "Every user sees the same layout" is less certain, because the same delta yields
  different tables as defaults change over time.
- More edge cases (a column both defaulted and re-added, ordering of injected new
  columns).

### Option 3: Per-user column layouts

Let each user pick their own columns, stored per user.

**Pros**:
- Maximum flexibility for individuals.

**Cons**:
- Directly contradicts the requirement (one shared layout everyone sees).
- Needs a user-scoped key and a read on every page for the current user, more
  surface and more queries, for a want no one expressed.

## Rationale

Option 1 wins on the Context forces. The tables must not regress and must stay
inert until used: fixing in place and falling back to the exact code defaults when
no row exists gives that for free, whereas a rewrite would risk the parts that
already work. The server/client and serialization constraint pushes hard toward
storing ids only and keeping the `ColumnDef` map (with its JSX) in the client
component; the explicit id list fits this directly. The delta model (Option 2)
buys automatic pickup of new columns, but at the cost of a layout that quietly
changes as code defaults move, which undercuts the "one shared, stable layout"
requirement; making new columns available-to-add rather than auto-shown is the
more predictable behavior for an admin tool. Per-user layouts (Option 3) are the
wrong shape for an explicitly global requirement.

On the permission: a dedicated `columns:write` was chosen over reusing
`user:admin`. The RBAC catalog is already granular (`asset:write`,
`location:write`, `scan:write`, `assignment:write`), so a distinct permission for
"restructure everyone's tables" matches the existing style and keeps it separate
from user and role management. The cost is a cross-service change (reseed aw-auth,
admins re-authenticate to receive the scope), accepted because it is a one-time
setup step and keeps the authorization model clean. Reusing `user:admin` would
avoid that step but conflate two unrelated capabilities.

On scope: category columns are limited to the three identifier fields already
carried on the asset object (IP, MAC, phone number). Offering the full per-type
field set as columns would require left-joining the five detail tables into the
list queries, which is real work and its own decision; it stays a follow-up so this
spec ships the configurable-layout capability without also reworking the list data
layer.
