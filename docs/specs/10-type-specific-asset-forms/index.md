# 10. Type-specific asset forms

**Date**: 2026-09-18
**Status**: In Progress

> Decision history (Context, Options considered, Rationale) lives in
> [rationale.md](./rationale.md). Verification steps in [verify.md](./verify.md).

## Summary

Today every asset type uses one shared form (spec 08), so a printer shows fields
that do not fit it (an assignee, a person) and there is nowhere to record the
fields that do fit (its IP address, whether it prints in color, its page count).
This spec gives each of the five types (Computer, Monitor, Printer, Phone,
Network) its own set of fields on top of the shared ones, stored in a small
per-type detail table joined one to one with the asset. A few fields (printer and
network IP, phone number, IMEI, MAC) get database indexes so they can be searched.
The shared fields and the freeform `spec` note stay as they are; nothing existing
is thrown away.

## Requirements

**User stories**:
- As an IT admin, I want the add/edit form to show only fields that fit the asset
  type, so a printer form does not ask for a person to assign it to and a phone
  form can capture its number and IMEI.
- As an IT admin, I want to record type-specific details (a printer's IP and page
  count, a monitor's size and resolution, a phone's carrier and plan, a switch's
  port count and firmware), so the inventory holds the facts each kind of device
  actually has.
- As the team, we want to search by the identifiers that matter (an IP, a phone
  number, a MAC), so we can find a device by how we actually refer to it.
- As the team, we want the existing form, tags, assignee, and location picker to
  keep working unchanged, so this adds capability without breaking what we have.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: The add/edit form shows the shared base fields plus the fields
  specific to the chosen type, and hides shared fields that do not apply to that
  type (Printers and Network gear have no Assignee). The field set for each type
  is: Computer (form factor, operating system, CPU, RAM, storage), Monitor (size,
  resolution, panel type, refresh rate, ports, curved), Printer (**IP address,
  required**, color mode, duplex, page count, connection, management URL), Phone
  (IMEI, phone number, carrier, storage, OS, plan), Network (IP address, MAC
  address, device role, port count, firmware, management URL). Printer IP address
  is the one type-specific field that is **required**; every other type-specific
  field is optional.
- **AC-2**: Saving the form writes the type-specific fields to the asset's per-type
  detail table (one row per asset, keyed by the asset id), in the **same
  transaction** as the asset row. The detail row is created on first save if it
  does not exist yet. Deleting the asset removes its detail row automatically
  (cascade). No orphan detail row is ever left behind.
- **AC-3**: The asset detail page (`/assets/[id]`) shows the type's specific fields
  (from its detail table) alongside the shared fields, and the edit form is
  pre-filled with the current type-specific values.
- **AC-4**: Type-specific input is validated by one shared per-type schema on the
  client (inline field errors) and re-checked in the Server Action (the trust
  boundary). Blank optional fields are stored as null. Invalid input shows inline
  errors and the action rejects it without writing, exactly as the shared fields do
  (spec 08 AC-4).
- **AC-5**: The searchable identifier fields (Printer IP, Phone IMEI and number,
  Network IP and MAC) are matched by the existing search (the top search bar and
  the per-list search), and each has a database index. Matching is
  **separator- and case-insensitive** for MAC addresses and phone numbers: a
  search for `aabbcc`, `AA:BB:CC`, or `aa-bb-cc` finds the same device, and
  `5551234567` finds `(555) 123-4567`. This is done by comparing a normalized form
  (strip punctuation and lowercase on both the stored value and the query), not a
  raw substring match.
- **AC-6**: Type stays locked on edit (spec 08 AC-3), so an asset never moves
  between detail tables. Editing a Computer only ever touches `computer_details`.
- **AC-7**: The type-specific writes happen inside the existing `createAsset` /
  `updateAsset` actions, gated on `asset:write` (spec 08 AC-6). A user without
  `asset:write` still sees no write controls and a direct action call is still
  rejected. Reads stay on `asset:read`.
- **AC-8**: No regression. The shared fields, tag generation, assignee picker, the
  location picker (spec 09), the category tables, the dashboard, and the discovered
  inbox all keep working. The freeform `spec` note stays on every type.
- **AC-9**: Migration is additive: five detail tables are added; existing assets
  keep all their data and simply have no detail row until first edited. No existing
  column is dropped and no data is transformed.

## Decision

**Chosen option**: Option 3: a **per-type detail table** for each asset type
(`computer_details`, `monitor_details`, `printer_details`, `phone_details`,
`network_details`), each one row per asset (the asset id is both primary key and
foreign key, `onDelete: cascade`), with the shared fields staying on `assets`. One
per-type **field registry** in code drives both the form and the detail page, and
one per-type **zod schema** validates the type's fields on client and server.

- **Data model**: five new detail tables, each keyed by `assetId` (PK = FK to
  `assets.id`, cascade). All type-specific columns are nullable. Typed columns
  give real types (integers, booleans, enums) and let the searchable fields carry
  a database index. The shared fields and the freeform `spec` text are unchanged.
- **Field registry** (`web/src/lib/asset-fields.ts`): one definition per type
  listing its fields (key, label, input kind, options, validation) and which shared
  fields it hides (Assignee for Printer and Network). The form renders the type's
  section from this registry, and the detail page renders the same fields from it,
  so a field is defined once and shows up in both places.
- **Validation**: `asset-schema.ts` gains a per-type `details` schema (keyed by
  type), composed with the existing base schema; parsed on the client and
  re-parsed in each action.
- **Writes**: `createAsset` / `updateAsset` are extended to accept the `details`
  object and upsert the matching detail row in the same transaction as the asset
  write. `deleteAsset` is unchanged; the cascade removes the detail row.

Alternatives (a single JSON attributes bag, one wide table of nullable columns)
are weighed in [rationale.md](./rationale.md).

## Feature design

**Data model sketch** (Drizzle, `web/src/db/schema.ts`; conventions match the
existing tables). Five new tables, each 1:1 with `assets`:

- **`computer_details`**: `assetId` uuid PK → `assets.id` (`onDelete: cascade`);
  `formFactor` text (laptop / desktop / all-in-one / tower); `operatingSystem`
  text; `cpu` text; `ramGb` integer; `storage` text. All nullable.
- **`monitor_details`**: `assetId` PK/FK (cascade); `sizeInches` numeric;
  `resolution` text; `panelType` text (IPS / VA / OLED / TN); `refreshHz` integer;
  `ports` text; `isCurved` boolean. All nullable.
- **`printer_details`**: `assetId` PK/FK (cascade); **`ipAddress` text NOT NULL
  (indexed, required)**; `colorMode` text (mono / color); `isDuplex` boolean;
  `pageCount` integer; `connection` text (network / USB); `mgmtUrl` text. Only
  `ipAddress` is required; the rest nullable.
- **`phone_details`**: `assetId` PK/FK (cascade); **`imei` text (indexed)**;
  **`phoneNumber` text (indexed)**; `carrier` text; `storageGb` integer; `os` text
  (iOS / Android); `plan` text. All nullable.
- **`network_details`**: `assetId` PK/FK (cascade); **`ipAddress` text (indexed)**;
  **`macAddress` text (indexed)**; `deviceRole` text (switch / router /
  access-point / firewall); `portCount` integer; `firmware` text; `mgmtUrl` text.
  All nullable.

Indexes: a plain btree index on each searchable column marked above. Not unique
(a null-friendly uniqueness rule on IMEI is a Follow-up, not now). No change to
`assets`, `people`, `machines`, or `locations`.

**State transitions**: none. Detail fields are plain attributes.

**API surface** (Server Actions in `web/src/app/(app)/assets/actions.ts`, extended;
reads in `web/src/db/queries.ts`; inputs validated by the extended shared schema):

| Action | Change | Result | Auth |
|---|---|---|---|
| `createAsset` | takes `details` (type-specific); inserts the asset then upserts the matching detail row in one transaction | `{ ok, message, tag }` | `asset:write` |
| `updateAsset` | takes `details`; updates the asset then upserts the matching detail row in one transaction | `{ ok, message }` | `asset:write` |
| `deleteAsset` | unchanged; the detail row is removed by the cascade | `{ ok, message }` | `asset:write` |
| `getAssetDetails` (new read) | returns the type's detail row for the edit prefill and the detail page | detail row or null | `asset:read` |
| `getAssets` / `getAssetsByType` (read) | left-join the detail tables so the indexed fields ride along for search | assets incl. searchable fields | `asset:read` |

**Key invariants**:
- Each asset has at most one detail row, in the table matching its type, keyed by
  `assetId`; type is locked on edit, so the table never changes for a given asset.
- Type-specific fields are optional and a blank value is stored as null, with one
  exception: a Printer's `ipAddress` is required (enforced by the DB `NOT NULL` and
  the per-type zod schema), so a printer cannot be saved without an IP.
- The asset write and its detail upsert succeed or fail together in **one
  `db.transaction`**. `createAsset` today loops its tag-generation retry
  (`onConflictDoNothing`) outside any transaction; the whole loop plus the detail
  insert must move inside one transaction. Both actions must return the asset's
  `id` (today `createAsset` returns only `tag` and `updateAsset` only `type`), so
  the detail upsert has the `assetId` key to write against.
- A field is defined once in the registry and drives both the form and the detail
  page, so the two cannot drift.
- Deleting an asset deletes its detail row (FK cascade); no orphan row survives.
- Numeric fields (e.g. `sizeInches`) round-trip as **strings** through Drizzle /
  postgres-js, so the per-type zod schema and the edit prefill must coerce number to
  and from string in both directions, or comparisons and display silently break.
- The collector quick-create path (`createAssetFromDevice`, spec 06) is not extended
  here: a quick-created asset simply has no detail row until its first manual edit
  creates one (the lazy upsert of AC-2). This is consistent with AC-9.

**Security model**: the type-specific writes are part of the existing `asset:write`
actions (`createAsset` / `updateAsset`), so the gate is unchanged (spec 08). The
detail page and the edit prefill read on `asset:read`. This is an internal,
auth-walled tool; no regulated-data compliance scope.

**Configuration required**: none. No new environment variables. Run
`npm run db:push` to create the five detail tables (additive; no data change).

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: add a Printer, fill IP, color mode, duplex, page count; it saves to
  `printer_details`, shows on the detail page, and the printer form never asked for
  an assignee, verifies **AC-1**, **AC-2**, **AC-3**.
- Search: a printer's IP and a phone's number are found by the search bar, verifies
  **AC-5**.
- Validation: a bad type-specific value (e.g. non-numeric page count) shows an
  inline error and the action writes nothing, verifies **AC-4**.
- Delete: deleting an asset removes its detail row (no orphan), verifies **AC-2**.
- Auth: a user without `asset:write` sees no write controls and a direct action
  call is rejected, verifies **AC-7**.
- Regression: shared fields, tag generation, the location picker, and the category
  tables keep working; existing assets with no detail row edit cleanly, verifies
  **AC-8**, **AC-9**.

## Build plan

Built as a thin end-to-end thread first (Tracer Bullet, the project default as in
specs 07 to 09): stand up one type end to end, then widen to the rest.

1. **Migration**: add the five detail tables (each `assetId` PK/FK cascade, nullable
   typed columns, btree indexes on the searchable columns). Additive only.
   Satisfies **AC-2**, **AC-5**, **AC-9**.
2. **Field registry + schema**: `web/src/lib/asset-fields.ts` (per-type field
   definitions: key, label, input kind, options, validation, and hidden shared
   fields) and extend `web/src/lib/asset-schema.ts` with a per-type `details`
   schema composed with the base. Satisfies **AC-1**, **AC-4**.
3. **Printer thread, end to end**: wrap `createAsset`'s tag-retry loop and
   `updateAsset` in a `db.transaction`, add `id` to both actions' `.returning()`,
   and upsert `printer_details` inside that transaction; render the printer section
   in `AssetFormDialog` from the registry; add `getAssetDetails` and prefill the
   edit form; show printer fields on the detail page. Satisfies **AC-1**, **AC-2**,
   **AC-3**, **AC-6**, **AC-7** (for Printer).
4. **Remaining types**: wire Computer, Monitor, Phone, Network through the same
   registry + child upsert path. Satisfies **AC-1**, **AC-2**, **AC-3** (all types).
5. **Search**: left-join the detail tables into `getAssets` / `getAssetsByType` so
   the indexed fields ride along; normalize MAC and phone (strip punctuation,
   lowercase) on both the stored/compared value and the query so separator and case
   differences still match; confirm the search bar and list search find IP, phone
   number, IMEI, and MAC. Satisfies **AC-5**.
6. **Shared-field visibility**: move the per-type hiding of shared fields (Assignee
   for Printer and Network, already done as a stopgap in `AssetFormDialog`) into
   the registry so it is defined in one place. Satisfies **AC-1**, **AC-8**.
7. **Edge cases + verify**: an existing asset with no detail row edits cleanly
   (lazy upsert); type stays locked so no detail row migrates; per-type validation
   errors; a regression pass over the location picker, tags, and tables; a
   `verify.md` pass. Satisfies **AC-4**, **AC-6**, **AC-8**, **AC-9**.

## Consequences

**Positive**:
- Each type's form asks for what that device actually has, and nothing it does not;
  the printer complaint that started this is fixed structurally, not by hiding one
  field.
- Type-specific fields are real typed columns, so integers, booleans, and enums are
  stored correctly, and the identifier fields carry indexes for search.
- One registry defines each field once for the form and the detail page, so they
  cannot drift; adding a field to a type is a small, local change.
- One to one cascade tables keep the type data cleanly separated and delete-safe.

**Negative / tradeoffs**:
- Five new tables and left joins in the list reads, versus one JSON column. More
  schema surface to hold in your head.
- Adding a brand-new type-specific field needs a column migration, not just a code
  change (the cost of typed columns over a JSON bag; accepted for the type safety
  and indexes the engineer wanted).
- The reads that feed search now join five tables; fine at this fleet's scale, a
  cost to revisit only if it grows very large.
- Because a Printer's IP is required, the first time an existing (pre-feature)
  printer is edited it must be given an IP before it can be saved. Existing
  printers keep their data until then (no detail row yet, per AC-9); they just
  cannot be re-saved without an IP.

**Neutral**:
- Additive migration: no column dropped, no data transformed, existing assets keep
  everything and gain a detail row on first edit.
- The freeform `spec` note stays on every type as before.
- Category table columns are unchanged; showing type-specific columns per list is
  out of scope (Follow-up).

## Follow-up

- [ ] Show selected type-specific fields as columns in the per-type category tables
      (this spec keeps the current fixed columns; fields live on the form and detail
      page).
- [ ] A null-friendly uniqueness rule on Phone IMEI if duplicate detection is ever
      wanted (kept non-unique now to avoid null-uniqueness surprises).
- [ ] Auto-fill `computer_details` (CPU, RAM, OS) from the collector's `machines`
      data instead of manual entry, where a machine is matched.
- [ ] Reconsider a JSON attributes bag if type-specific fields start churning often
      enough that per-field migrations become a drag.
- [ ] Per-type form and registry conventions are not yet in `web/AGENTS.md`; add a
      note once the pattern lands (via `/sync`).

## Rationale

See [rationale.md](./rationale.md) for the options considered and why this shape
was chosen.
