# Rationale, spec 09: hierarchical locations

Decision record for [index.md](./index.md). `/develop` does not need this file.

## Context

An asset's location is a single free-text column (`assets.location`). Nothing
stops two spellings of the same place, nothing can be rolled up ("everything in
New York"), and nothing can be filtered by area. The fleet is organized
geographically (a region, then sites within it, and potentially rooms or floors
within those), which is a tree, but the current model cannot express it.

The forces at play:
- The hierarchy has genuinely variable depth (some sites need a floor level, some
  do not), so a fixed two- or three-column shape would not fit for long.
- Writes are rare and low volume (an admin curating a tree of tens to low hundreds
  of nodes); reads (the filter, the picker) are the common path but still small.
- The system already has an established shape for this kind of feature from spec 08
  (a shared zod schema on both client and server, `ActionResult` Server Actions
  gated by a permission check, Base UI dialogs, a `canWrite` prop from the RSC
  page). A new feature should reuse it, not invent a parallel one.
- Assignment integrity matters: a device must land somewhere sensible, and
  reorganizing or deleting locations must never silently orphan devices or corrupt
  the tree.
- The permission model is owned by a separate service (aw-auth). Adding a new
  permission is possible but is a cross-service change, not a web-only one.

The consequence of not deciding: location data stays untrustworthy free text, and
any "where is our gear" question stays a manual grep.

## Options considered

### Option 1: Adjacency list + leaf-only FK + recursive subtree query (chosen)

Each `locations` row stores its `parentId`; an asset stores a nullable
`locationId` that must point at a leaf. Subtree membership (for the filter and the
guards) is computed on demand with a Postgres `WITH RECURSIVE` query.

**Pros**:
- Simplest possible tree schema: one nullable self-FK, no derived data to keep in
  sync. Moves and renames are a single-row update.
- Matches Postgres and Drizzle idioms directly; recursive CTEs are a standard,
  well-understood tool.
- Cheap to reason about and to keep correct; nothing to rebuild on a move.

**Cons**:
- Subtree reads need a recursive query rather than a single indexed range scan;
  at very large tree sizes this is slower than a materialized path.
- "Is a leaf" and "is a descendant" are computed, not stored, so the guards run a
  small query each.

### Option 2: Materialized path (store an ancestry string/array per node)

Each node stores its full path (for example `nyc/bronx`), so a subtree filter is a
prefix match and needs no recursion.

**Pros**:
- Subtree filtering is a simple, indexable prefix query; fast at large scale.
- Reading ancestry needs no join.

**Cons**:
- The path is derived data that must be rewritten for a node **and its whole
  subtree** on every move, exactly the operation this feature supports; that is the
  classic materialized-path bug source.
- More code and more ways to drift out of sync, for a scale this project does not
  have. Premature optimization.

### Option 3: Closure table (a row per ancestor/descendant pair)

A separate table records every ancestor-descendant relationship, so subtree and
ancestor queries are plain joins.

**Pros**:
- Both subtree and ancestor queries are fast, simple joins.
- Handles very deep or very wide trees well.

**Cons**:
- A whole second table to maintain transactionally on every insert/move/delete;
  the most moving parts of the three.
- Overkill for tens to low hundreds of mostly-static nodes.

### Cross-cutting sub-decisions

- **Assignment target: leaf-only (chosen) vs any node.** The engineer chose
  leaf-only: a device is always at a definite, bottom-level place, which keeps
  rollups unambiguous. The cost is the leaf-conflict rule (you must move devices
  before nesting a location that holds them); accepted, and guarded in the UI.
- **Delete: block-until-empty (chosen) vs cascade vs unassign.** Block-until-empty
  never destroys data by surprise; the admin explicitly moves children and devices
  first. Cascade and auto-unassign are faster but lose data silently.
- **Permission: new `location:write` (chosen) vs reuse `asset:write`.** The
  engineer chose a dedicated permission so curating the location tree can be
  restricted separately from editing assets. The cost is an aw-auth RBAC seed
  change and a re-seed step; accepted.
- **Migration: drop the free-text column (chosen) vs auto-create nodes vs keep as a
  label.** The current location text is throwaway seed data, so a clean slate is
  simplest; existing assets start with no location. No migration mapping code to
  write or maintain.
- **Sibling-name uniqueness with a NULL parent.** Postgres treats NULLs as
  distinct in a normal unique index, so `UNIQUE (parentId, name)` would **not**
  stop two top-level locations sharing a name. Enforce top-level uniqueness with a
  partial unique index on `name WHERE parent_id IS NULL` (plus the ordinary unique
  `(parent_id, name)` for the non-null case), and check it in the action for a
  clean error either way.

## Rationale

Adjacency list wins on the forces that actually apply here: the writes this feature
adds are moves and renames, and adjacency list makes those a single-row update
with nothing derived to rebuild, while materialized path and closure table both
add exactly the maintenance burden that a low-scale, tree-editing feature is most
likely to get wrong. The subtree read cost that would justify Option 2 or 3 is a
problem this fleet does not have (tens to low hundreds of nodes), so paying for it
now is premature optimization; the Follow-up records the switch to make if that
ever changes.

Leaf-only assignment, block-until-empty deletes, and the cycle/leaf guards were
the engineer's calls; together they mean the tree cannot reach a broken or
orphaning state through the UI, which is the integrity force from Context. The
new `location:write` permission was also the engineer's choice; it costs a
cross-service seed change, made explicit as a build task and a prerequisite rather
than hidden. Reusing spec 08's shape (shared zod schema, gated Server Actions,
Base UI dialogs, `canWrite` prop) keeps the new surface small and consistent with
the rest of the app, honoring the "reuse the established pattern" force.
