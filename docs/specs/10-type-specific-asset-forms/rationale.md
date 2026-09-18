# Rationale, spec 10: type-specific asset forms

Decision record for [index.md](./index.md). `/develop` does not need this file.

## Context

Spec 08 built one shared `AssetFormDialog` and one `assets` table with a fixed set
of columns for every type. That was the right call to ship editing quickly, but it
has two costs now that the fleet is real:

- The form shows fields that do not fit a type. A printer is shared infrastructure,
  not assigned to a person, yet the form offers an Assignee. (A stopgap already
  hides Assignee for Printer and Network in the form; this spec makes that part of
  a proper per-type field model.)
- There is nowhere to record the fields that a type actually has: a printer's IP,
  color mode, and page count; a phone's IMEI, number, carrier, and plan; a monitor's
  size, resolution, and panel; a switch's port count and firmware. Today these get
  crammed into the freeform `spec` text or lost.

The forces at play:
- The five types have genuinely different attributes, and a few of those attributes
  (IP, phone number, IMEI, MAC) are the identifiers people search by, so they want
  real types and indexes, not free text.
- Writes are low volume (an admin editing one asset at a time); the common path is
  reads (lists, the detail page, search).
- Spec 03 (the data model) already envisioned a `specs jsonb` structured-spec column
  on `asset` that was never built, so structured per-type data was always intended.
- Spec 08 locks the type on edit, which matters here: if the type cannot change, a
  per-type table for each asset never has to migrate between tables.
- The system has an established shape (a shared zod schema on client and server,
  `ActionResult` Server Actions gated by a permission, a `canWrite` prop); this
  should reuse it, not invent a parallel one.

The consequence of not deciding: the form keeps asking printers for an assignee,
and type-specific facts keep living in free text where nothing can query them.

## Options considered

### Option 1: One JSON attributes bag on `assets`

Add a single `attributes jsonb` column to `assets`; each type's shape is defined and
validated in code (per-type zod). This is what spec 03's `specs jsonb` gestured at.

**Pros**:
- One column, no new tables; adding or changing a field is a pure code change, no
  migration.
- Flexible; fits a small internal fleet where the field set will keep evolving.

**Cons**:
- Not natively typed; integers, booleans, and enums are just JSON, validated only in
  code.
- Searching or filtering a field means JSON operators and a GIN index, clumsier than
  a plain indexed column for the identifier fields the team searches by.

### Option 2: One wide table of nullable columns on `assets`

Add every type-specific field as a nullable column on `assets` (printer_ip, imei,
resolution, mac, and so on).

**Pros**:
- Typed and indexable, no joins.
- Simplest query shape (everything on one row).

**Cons**:
- A wide, sparse table: most columns are null for most rows (a printer row has no
  IMEI, a phone row has no page count), which is noisy and easy to misuse.
- Column name collisions across types (two types both want `ip_address`,
  `mgmt_url`), forcing prefixes and losing the clean per-type grouping.

### Option 3: Per-type detail table, 1:1 with the asset (chosen)

A small detail table per type (`computer_details`, … `network_details`), each keyed
by `assetId` (PK = FK, cascade), holding only that type's fields.

**Pros**:
- Typed columns per type, indexes on the searchable identifier fields, and a clean
  per-type grouping with no cross-type name collisions.
- 1:1 cascade means deleting an asset removes its detail row for free; no orphans.
- Type is locked on edit, so a given asset's detail table never changes; the model
  stays simple.

**Cons**:
- Five new tables and left joins in the list reads.
- A brand-new type-specific field needs a column migration, not just a code change
  (the JSON bag's one advantage).

### Option 4: Hybrid (JSON bag plus a few promoted identifier columns)

Keep a single `attributes jsonb` on `assets` for the bulk of type-specific fields,
but promote only the roughly five searchable identifiers (IP, MAC, IMEI, phone
number) to real indexed columns directly on `assets`. Because only one type ever
populates each identifier, there is no name collision.

**Pros**:
- Answers the JSON bag's one real weakness (no indexes on the fields people search)
  without five new tables, five-way joins, or a migration for every non-identifier
  field added later.
- At roughly 100 machines with admin-only single-row edits, the wide-table "sparse
  and noisy" objection is mild.

**Cons**:
- Two storage mechanisms for one concept (some fields in JSON, some in columns), so
  a reader has to know which is which.
- The non-identifier fields stay untyped JSON, validated only in code, so the type
  safety the engineer wanted is only partial.

### Cross-cutting sub-decisions

- **Searchable fields (chosen: index a few).** Printer IP, Phone IMEI and number,
  Network IP and MAC get btree indexes and ride along in the list reads so the
  existing search matches them. The rest are display and edit only.
- **Shared base (chosen: keep it, add extras).** The shared fields stay on `assets`
  as spec 08 defined them; type-specific fields go in the detail tables. The
  registry also records which shared fields a type hides (Assignee for Printer and
  Network).
- **Freeform `spec` (chosen: keep as notes).** The existing `spec` text stays on
  every type as a freeform note; structured fields sit beside it. No data lost.
- **Field registry (a code convention, not asked).** One per-type definition drives
  both the form and the detail page, so a field is declared once. The alternative,
  five separate form components, duplicates layout and drifts.

## Rationale

The engineer chose the per-type detail table (Option 3) over the lighter JSON bag
(Option 1). It wins on the forces that actually apply here: the team searches by
identifier fields (IP, phone number, MAC), and typed, indexed columns serve that
directly, where a JSON bag would need JSON operators and a GIN index for the same
result. The type is already locked on edit (spec 08), which removes the usual
downside of a table-per-type model (never having to migrate a row between tables).
The wide-table option (Option 2) was rejected because a single sparse table with
every type's columns collides on names (`ip_address`, `mgmt_url` recur) and buries
each type's real shape in mostly-null columns.

The hybrid (Option 4) is the closest "materially simpler" middle ground, and at
this scale it would have worked. It was passed over because it splits one concept
across two storage mechanisms (JSON for most fields, columns for the identifiers),
which is harder to reason about than one clean per-type table, and it leaves the
non-identifier fields untyped. The engineer chose full type safety and one clear
home per type over the smaller schema footprint; the JSON bag (Option 1) stays on
record as the fallback if per-field migrations ever become a drag.

The cost accepted is real: five tables, joins in the list reads, and a column
migration for each new field. For a small internal fleet where the field set is now
fairly settled, that cost is low and buys type safety, clean per-type grouping, and
indexes the team wanted. The JSON bag stays on record as the switch to make if
type-specific fields start churning often enough that per-field migrations become a
drag (Follow-up). Reusing spec 08's shape (shared zod schema, gated Server Actions,
one form component) keeps the new surface small and consistent with the rest of the
app; the type-specific writes are folded into the existing `asset:write` actions
rather than adding a parallel path.
