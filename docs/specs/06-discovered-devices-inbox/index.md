# 06. Discovered-devices inbox

**Date**: 2026-08-26
**Status**: In Progress

> Decision history (Context, Options considered, Rationale) lives in
> [rationale.md](./rationale.md). Verification steps in [verify.md](./verify.md).

## Summary

When the collector scans the fleet, machines that don't match a managed asset are stored but invisible in the UI. This spec adds the **discovered-devices inbox** at `/scans`: a screen that lists those unmatched machines and lets an admin turn each one into managed inventory. For every device the admin can link it to an existing asset (with suggested matches offered), quick-create a new asset from it in one click, or ignore it so it drops out of the inbox. The whole feature reuses the existing `machines` table plus one new nullable column (`ignoredAt`); no new tables and no separate `discovered_device` table.

## Requirements

**User stories**:
- As an IT admin, I want to see every scanned machine that isn't yet a managed asset, so that I can bring it into inventory or dismiss it.
- As an IT admin, I want the inbox to suggest which existing asset a device probably is, so that linking is one click instead of a search.
- As an IT admin, I want to create a new asset straight from a discovered device, so that I don't retype details the scan already captured.
- As an IT admin, I want to ignore devices I don't care about, and restore one later if I change my mind, so that the inbox stays a real work queue.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: `/scans` lists all unmatched, non-ignored machines (`assetId IS NULL AND ignoredAt IS NULL`), each showing hostname, IP, subnet, kind, OS, serial, and last-seen time. The list handles the full unmatched set without loading everything unbounded (paginate or virtualize).
- **AC-2**: For each device the inbox surfaces up to 3 suggested existing assets, ranked by match strength (exact serial, then hostname/serial fuzzy, then same subnet), each linkable in one click. A device with no plausible match shows none.
- **AC-3**: An admin can link a device to any existing asset through a searchable picker. Linking sets `machines.assetId` and the asset's `lastSync`, and the device leaves the inbox.
- **AC-4**: An admin can quick-create a new asset from a device: a unique `tag` is generated, `type` is inferred from `kind`, `name` comes from hostname (IP fallback), `serial` and a `spec` summary are prefilled from the scan, and `status` is set to `storage`. The new asset is linked to the device and the device leaves the inbox.
- **AC-5**: An admin can ignore a device (sets `ignoredAt`); it leaves the active inbox and appears under an "Ignored" filter, from which it can be restored (`ignoredAt` back to null, device returns to the inbox).
- **AC-6**: Ignored state survives re-scans. A later ingest of the same machine does not clear `ignoredAt` and does not resurface the device in the active inbox.
- **AC-7**: Write actions require permission, checked server-side: `asset:write` for link, quick-create, ignore, and restore; viewing `/scans` requires `scan:read`. A user without the permission is denied (no mutation happens) and the UI hides the control.
- **AC-8**: The inbox handles the empty state (no unmatched devices) with a clear message, and handles concurrent resolution: acting on a device already linked or ignored by someone else does not error and does not create a duplicate asset.

## Decision

**Chosen option**: Option 2: Reuse `machines`, add one `ignoredAt` column.

Build the discovered-devices inbox on the existing `machines` table, adding a single nullable `ignoredAt` timestamp; derive inbox / ignored / matched states from `assetId` + `ignoredAt`, compute match suggestions at read time, and expose link / quick-create / ignore / restore as permission-checked Server Actions.

## Feature design

**Data model sketch**:

Reuse `web/src/db/schema.ts` `machines` table. Add one column:

| Column | Type | Notes |
|---|---|---|
| `ignoredAt` | `timestamp` (with time zone), nullable | `null` = active; set = dismissed from the inbox. Restore sets it back to `null`. Default `null`. |

No new tables. `assets` is unchanged. Derived states (no stored status column):
- **Inbox (discovered)**: `assetId IS NULL AND ignoredAt IS NULL`
- **Ignored**: `assetId IS NULL AND ignoredAt IS NOT NULL`
- **Matched** (already handled, never in the inbox): `assetId IS NOT NULL`

Quick-create maps a device to a new `assets` row:
- `tag`: generated `OPUS-<TYPE3>-<5 random base36>` (e.g. `OPUS-CMP-7f3k9`), retried on unique-constraint collision.
- `type`: `windows` → `Computer`, `printer` → `Printer`, else `Computer`.
- `name`: `hostname`, falling back to `ip`.
- `serial`: device serial (may be null).
- `spec`: short summary assembled from `hardware` (e.g. CPU + RAM) when present, else null.
- `status`: `storage` (exists but not formally deployed).
- After insert: set `machines.assetId` to the new asset id and `assets.lastSync` to the machine's `lastSeenAt`.

**State transitions** (a `machines` row, from the inbox's point of view):

```
discovered (assetId null, ignoredAt null)
  ├─ link to existing asset ─────▶ matched (assetId set)      [terminal for the inbox]
  ├─ quick-create asset ─────────▶ matched (assetId set)      [terminal for the inbox]
  └─ ignore ─────────────────────▶ ignored (ignoredAt set)
ignored ── restore ──────────────▶ discovered
```

A re-scan upserts the row's scan fields but never touches `assetId` or `ignoredAt`, so it cannot move a row backward between these states.

**API surface** (writes are Next.js Server Actions, per frontend spec 05 section 5; reads are RSC queries in the data layer):

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `getDiscoveredDevices({ includeIgnored })` | RSC query (`db/queries.ts`) | `includeIgnored:boolean` | device rows + up to 3 ranked asset suggestions each | `scan:read` (page gate) | none (read) |
| `linkDevice(machineId, assetId)` | Server Action | `machineId:uuid`, `assetId:uuid` | ok / updated row | `asset:write` | not-found, already-matched (no-op ok) |
| `createAssetFromDevice(machineId)` | Server Action | `machineId:uuid` | new asset id + tag | `asset:write` | not-found, tag-collision (retried) |
| `ignoreDevice(machineId)` | Server Action | `machineId:uuid` | ok | `asset:write` | not-found |
| `restoreDevice(machineId)` | Server Action | `machineId:uuid` | ok | `asset:write` | not-found |

Asset search for the manual link picker reuses the existing `getAssets()` (asset count is small; filter client-side), or a thin `searchAssetsForLink(query)` action if that proves heavy. Each action revalidates the `/scans` path after mutating.

**Key invariants**:
- A `machines` row is in exactly one inbox-relevant state, decided by `assetId` then `ignoredAt` (matched wins: if `assetId` is set the row is matched regardless of `ignoredAt`).
- `assets.tag` is unique; quick-create must retry generation on collision, never fail the whole action on first clash.
- Linking or quick-creating never produces a duplicate asset: link reuses the chosen asset; quick-create inserts exactly one asset then links it (wrap the insert-then-link in a single transaction).
- The ingest upsert (`web/src/db/ingest.ts`) `onConflictDoUpdate.set` must not include `ignoredAt` (nor reset it), so ignored devices stay ignored across scans.

**Security model**:
- Viewing `/scans` requires `scan:read`; the four write actions each require `asset:write`. Enforced server-side inside every action (`getCurrentUser()` then `hasPermission(user, ...)`), not only in the UI. The client hides controls the user cannot use, but the server is the real gate (matches frontend spec 05 section 6).
- Internal, authenticated tool; the data is device inventory (hostnames, serials, IPs), no PII or regulated data, so no compliance scope applies.

**Configuration required**:
- No new environment variables or credentials. Uses the existing database and auth setup.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path, link: a discovered device with a matching serial shows that asset as the top suggestion; one click links it; it disappears from the inbox and the asset's `lastSync` updates. Verifies **AC-2**, **AC-3**.
- Happy path, quick-create: a discovered Windows machine with no match is quick-created; a new `Computer` asset appears with generated tag, prefilled serial/spec, status `storage`, linked to the machine. Verifies **AC-4**.
- Ignore survives rescan: ignore a device, re-post the same machine to `/api/ingest/scan`, confirm it stays out of the active inbox and remains under Ignored; restore returns it. Verifies **AC-5**, **AC-6**.
- Permission denied: a user without `asset:write` sees no action controls, and a direct call to `linkDevice`/`createAssetFromDevice`/`ignoreDevice` is rejected with no mutation. Verifies **AC-7**.
- Concurrency / empty: acting on a device already linked by someone else is a safe no-op (no duplicate asset); with nothing unmatched, the inbox shows a clear empty state. Verifies **AC-8**.

## Build plan

Built as one thin end-to-end slice first, then thickened (no build approach is recorded for this project, so the default is end-to-end / Tracer-Bullet slices). The data-model migration is task 1.

1. **Migration**: add nullable `ignoredAt` to `machines` in `schema.ts`; apply with `npm run db:push`. Satisfies **AC-5**, **AC-6**.
2. **Data layer**: add `getDiscoveredDevices({ includeIgnored })` in `db/queries.ts` (unmatched rows + up to 3 ranked asset suggestions computed at read time); verify/keep `ingest.ts` upsert from touching `ignoredAt`. Satisfies **AC-1**, **AC-2**, **AC-6**.
3. **Server actions**: `linkDevice`, `createAssetFromDevice` (tag generation + collision retry + `kind`→`type` map + prefill, in a transaction), `ignoreDevice`, `restoreDevice`, each guarded by `getCurrentUser` + `hasPermission('asset:write')` and revalidating `/scans`. Satisfies **AC-3**, **AC-4**, **AC-5**, **AC-7**, **AC-8**.
4. **Inbox UI** at `/scans` (`DiscoveredInbox`, per frontend spec 05 section 4): device list (paginated/virtualized) with per-row suggestions and actions, a searchable link dialog, a quick-create button, ignore/restore, an "Ignored" filter toggle, and an empty state; gate the page on `scan:read` and hide write controls when the user lacks `asset:write`. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-7**, **AC-8**.
5. **Polish edges**: idempotent action guards for already-resolved devices, list revalidation after each action, and the empty/loading states. Satisfies **AC-8**.

## Consequences

**Positive**:
- Closes the scan pipeline loop: unmatched machines become actionable instead of invisible.
- Smallest possible schema change (one nullable column), no new tables, no data migration.
- Reuses existing auth, RBAC helpers, Drizzle queries, and Server Action patterns; nothing new to operate.
- Sets up the later Add/Edit asset form (quick-create is a minimal seam it can grow into) and the category list views.

**Negative / tradeoffs**:
- `machines` now carries an inbox concern (`ignoredAt`), slightly overloading a table that also holds live scan data.
- No persisted resolution history (who linked/ignored a device, when); only current state is kept. If an audit trail is wanted later it needs the `activity_event` table from spec 03, which is not built.
- Quick-create makes deliberately shallow assets (generated tag, inferred type, blank location/model); they need cleanup once the full Add/Edit form exists.
- Suggestions are heuristic; a wrong top suggestion could be linked by mistake (mitigated by showing the candidate's details and keeping the manual picker).

**Neutral**:
- Reconciliation still matches on serial only; this feature does not change auto-matching, it adds the manual path for what serial-matching misses.
- Collector run history (the other half of the `/scans` page in spec 05) is explicitly out of scope here; it needs a `scan_run` table and collector changes, tracked separately.

## Follow-up

- [ ] Add/Edit asset form (backlog): let quick-created assets be fully edited; quick-create is the seam it plugs into.
- [ ] Collector run history at `/scans`: needs a `scan_run` table and the collector emitting run IDs; deferred out of this spec.
- [ ] Consider persisting resolution history (link `activity_event` from spec 03) if an audit trail of who resolved what is later required.
- [ ] Broaden reconciliation beyond serial (hardware_uuid, mac, hostname) so fewer devices land in the inbox in the first place.
