# 06. Discovered-devices inbox — rationale

Decision history for [index.md](./index.md). Context, options weighed, and why.

## Context

The scan pipeline already works end to end: the collector posts runs to `/api/ingest/scan`, which reconciles each machine to an asset by serial and writes a `machines` row. A machine that matches gets `assetId` set; a machine that does not match is stored with `assetId = null`. Reconciliation today matches on serial only.

The unmatched rows are the problem. Nothing surfaces them, so a real device seen on the wire (a computer whose serial was blank at scan time, a printer added after its asset record, a machine nobody has entered yet) sits in the database with no way for a human to act on it. The `/scans` page is a placeholder. There is no way to say "yes, that is asset MAC-2024-001, link them", "that is new, create it", or "ignore that, it is a guest laptop". Without this, the managed inventory drifts away from what is actually on the network, and the value of scanning is lost.

Forces at play: the feature is internal and auth-walled (no public exposure, no regulated data beyond device inventory). Auth and RBAC already exist (`getCurrentUser`, `hasPermission`, permission claims in the token). The actual schema is simpler than the original data-model spec (03) proposed: one `machines` table carries both matched and discovered machines, with no snapshot-history or `resolved_action` columns. Any design must fit that reality rather than the richer model spec 03 sketched. The dedicated Add/Edit asset form is a separate backlog item that does not exist yet, so creating an asset here cannot depend on it.

## Options considered

### Option 1: Separate `discovered_device` table (as spec 03 sketched)

Keep discovered devices in their own table, upserted on ingest, with `resolved`, `resolved_action`, and `suggested_match_asset_id` columns; the inbox reads that table.

**Pros**:
- Matches the original data-model spec (03).
- Keeps "raw unmatched scans" conceptually separate from "live linked machines".

**Cons**:
- The code already collapsed matched and discovered machines into one `machines` table. Adding a second table means dual writes on ingest, a sync problem between the two, and a migration of existing rows.
- Duplicates most columns already on `machines` (hostname, ip, serial, os, hardware, health).
- More surface area for the same outcome; a discovered device is just a `machines` row whose `assetId` is null.

### Option 2: Reuse `machines`, add one `ignoredAt` column (chosen)

A discovered device is a `machines` row with `assetId IS NULL`. Add a single nullable `ignoredAt` timestamp so a device can be dismissed. Inbox, ignored, and matched are all derived from `assetId` + `ignoredAt`. Suggestions are computed at read time; nothing is persisted.

**Pros**:
- One table, one small migration, no dual writes, no row migration.
- Linking is already modeled (set `assetId`); only "ignore" is new state.
- Fits the code as it actually is, not as spec 03 imagined it.

**Cons**:
- Overloads `machines` with an inbox concern (`ignoredAt`) that a purist would separate.
- No persisted per-device resolution history (who linked what, when); only current state.

### Option 3: Resolve-on-ingest with an admin allowlist

Auto-create assets for every unmatched machine and let the admin merge or delete afterward.

**Pros**:
- Zero manual step for the common case.

**Cons**:
- Exactly the failure the pipeline was built to avoid: silent creation of junk assets from every printer, guest laptop, and mis-scanned host. Pollutes inventory and reports. Rejected on principle.

## Rationale

The deciding force is that the code already made a choice spec 03 did not anticipate: matched and discovered machines live in one `machines` table. Option 1 would fight that by re-introducing a separate table, paying for dual writes and a migration to solve a problem the single table already solves. Option 2 accepts reality: a discovered device is just an unlinked `machines` row, linking is already "set `assetId`", and the only genuinely new state is "ignored", which one nullable column captures. Ignored-survives-rescan (AC-6) falls out for free, because the ingest upsert's `set` clause does not include `ignoredAt`, so a re-scan leaves it untouched (the build must keep it that way).

Suggestions are computed at read time rather than stored, following the rule that derived values go stale; the asset count is in the low hundreds, so ranking candidates per device on read is cheap. Quick-create is one click by design (the whole point is not retyping scan data), which is why `type` is inferred from `kind` and `status` defaults rather than prompting; the record is fully editable later once the Add/Edit form exists. Option 3 is rejected outright: auto-creating assets is the anti-goal the reconcile step was written to prevent.
