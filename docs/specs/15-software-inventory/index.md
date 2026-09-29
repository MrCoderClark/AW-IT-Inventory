# 15. Software inventory (tracked-software watchlist)

**Date**: 2026-09-28
**Status**: Accepted

## Summary

Admins keep a small watchlist of software titles they care about (Chrome, Office,
antivirus, and so on). When the collector scans a Windows computer it reads that
machine's installed programs, and the app records the ones that match the
watchlist. A new `/software` page lists each tracked title with how many machines
have it and which versions are out there, and each computer's detail page shows
its own tracked software. It is a focused watchlist, not a full dump of everything
installed, and it only covers computers that are real inventory assets.

## Requirements

**User stories**:
- As an IT admin, I want to track specific software titles across the fleet, so I
  can see where they are installed and on which versions without visiting machines.
- As an IT admin, I want to manage that watchlist from the app, so I decide what is
  tracked without editing files on the collector host.
- As an IT admin, I want a computer's detail page to show its tracked software, so I
  can see one machine's picture at a glance.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: An admin with `scan:write` can add and remove tracked software titles on
  the Admin page; the list persists and is read by the app. A title is a plain
  string (its label and its match term).
- **AC-2**: During the existing WinRM collect, the collector reads a Windows
  machine's installed programs from the registry Uninstall keys (HKLM 64-bit, HKLM
  `WOW6432Node`, and HKCU) and includes them (name, version, publisher, install
  date) in the scan payload. It never uses `Win32_Product` (which is slow and can
  trigger MSI repair).
- **AC-3**: On `/api/ingest/scan`, for a machine matched to a **Computer** asset, the
  app stores the installed programs whose name **contains** a watchlist title (case
  insensitive), and fully replaces that asset's previous software (current state, no
  history). Software from an unmatched machine, a non-Computer asset, or a title not
  on the watchlist is not stored.
- **AC-4**: The `/software` page lists **every** tracked title with its fleet install
  count (distinct Computer assets) and the distinct versions seen; a title installed
  on zero machines shows a count of 0. Any `asset:read` user can view it.
- **AC-5**: Selecting a tracked title shows the Computer assets that have it, each
  with its installed version, linking to that computer's detail page.
- **AC-6**: A computer's detail page shows a panel listing its tracked software
  (name, version, publisher), with a clear empty state when none was found.
- **AC-7**: Watchlist management is gated on `scan:write`: a user without it sees no
  management controls, and the server action refuses the call even if invoked
  directly.

## Decision

**Chosen option**: Option 2: a curated watchlist with web-managed titles, filtered
web-side at ingest, stored as current state per Computer asset.

Track only admin-chosen titles (a web-managed `tracked_software` list, read at
ingest), match them against each machine's registry-collected programs by
case-insensitive substring, and store the current matches per Computer asset in an
`installed_software` table. Aggregate the `/software` view by tracked title.

## Feature design

**Data model sketch**:

`tracked_software` — the watchlist (managed on `/admin`, gate `scan:write`):
- `id` uuid PK
- `name` text, **unique on `lower(name)`**, not null — the tracked title and the
  case-insensitive "contains" match term
- `createdAt`, `updatedAt` timestamptz

`installed_software` — current tracked software per Computer asset:
- `id` uuid PK
- `assetId` uuid not null → `assets.id` (`onDelete: cascade`)
- `trackedId` uuid not null → `tracked_software.id` (`onDelete: cascade`)
- `name` text not null — the actual DisplayName found (for example "Google Chrome")
- `version` text · `publisher` text · `installDate` text (registry values are strings)
- `lastSeenAt` timestamptz not null — the scan that recorded it
- **unique** (`assetId`, `trackedId`, `name`, `version`)

Relationships: `assets` 1:N `installed_software` (only Computer assets get rows,
enforced at ingest, matching how `printer_counters` keys on `assetId`);
`tracked_software` 1:N `installed_software`. No new column on `machines`; software is
its own table because the `/software` aggregate groups across machines by title.

**State transitions**: none. `installed_software` is current state: a Computer's rows
are deleted and reinserted on each Windows scan of that asset.

**API surface**:

| Endpoint / action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/ingest/scan` (extended) | POST | `hosts[].software[]` (name, version, publisher, install_date) | matched/upserted counts | service `ingest:write` | 401, 403 |
| `addTrackedSoftware` (server action) | action | `name: string` | `ActionResult` | cookie + `scan:write` | forbidden, duplicate name |
| `removeTrackedSoftware` (server action) | action | `id: uuid` | `ActionResult` | cookie + `scan:write` | forbidden |
| `/software` (page) | GET | — | aggregate rows (title, count, versions) | cookie `asset:read` | — |
| `/software/[trackedId]` (drill-down) | GET | `trackedId` | Computer assets + versions | cookie `asset:read` | 404 unknown id |

The collector fetches nothing new: the watchlist filter runs web-side at ingest, so
the collector just collects and sends. The `/software/[trackedId]` drill-down may be
a route or an in-page expansion; `/develop` picks the form, the behavior is AC-5.

**Key invariants**:
- `tracked_software.name` is unique case-insensitive; empty names are rejected.
- `installed_software` rows exist only for Computer assets (ingest enforces via the
  match to an asset of type Computer); unmatched machines contribute nothing.
- A Computer's `installed_software` always reflects the latest Windows scan of that
  asset (full replace, never merged with an older scan).
- The `/software` count for a title is the number of **distinct** Computer assets
  with a matching row; versions shown are the distinct `version` values.

**Security model**: viewing `/software`, the drill-down, and the computer software
panel is open to any signed-in `asset:read` user. Managing the watchlist requires
`scan:write` (reused from the discovery toggles and the counter report; no new
permission to seed). The collector posts software with its existing service token
(`ingest:write`). This is internal IT asset data; no PII or regulated-data scope.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: an admin adds "Chrome"; a Windows scan of a matched Computer that has
  Chrome installed records it; `/software` shows Chrome with count 1 and its version,
  the drill-down lists that computer, and the computer's panel shows Chrome. Verifies
  **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-6**.
- Failure case: a scanned machine that is **not** matched to a Computer asset (still
  in the discovered inbox) has Chrome installed; no `installed_software` row is
  stored. Verifies **AC-3**.
- Auth/permission: a user without `scan:write` sees no watchlist controls on `/admin`
  and a direct `addTrackedSoftware` call is refused. Verifies **AC-7**.

## Build plan

Ordered as a Tracer Bullet: stand up a thin thread from watchlist to collection to
display, then thicken. The data-model migration is task 1.

1. **Migration + schema**: the `tracked_software` and `installed_software` tables
   (Drizzle), with the unique constraints above. Satisfies **AC-1**, **AC-3** (data).
2. **Watchlist management**: `tracked_software` read/insert/delete helpers, the
   `addTrackedSoftware` / `removeTrackedSoftware` server actions gated on `scan:write`,
   and the Admin page card to list, add, and remove titles (hidden without the
   permission). Satisfies **AC-1**, **AC-7**.
3. **Collector software collection**: read the registry Uninstall keys in the existing
   WinRM PowerShell call, add a `software` list (name, version, publisher, install
   date) to the Windows host model and the ingest payload. Best effort: a software
   read failure must not fail the machine collect. Satisfies **AC-2**.
4. **Ingest storage**: on `/api/ingest/scan`, for a matched Computer asset, filter the
   posted software to watchlist matches (case-insensitive contains), then replace that
   asset's `installed_software` rows. Best effort, like the printer counter. Satisfies
   **AC-3**.
5. **/software page + drill-down**: the aggregate list (every tracked title, distinct
   Computer count, distinct versions, zero-count titles shown), and the per-title view
   of Computer assets with their versions linking to each computer. Gated `asset:read`.
   Satisfies **AC-4**, **AC-5**.
6. **Computer detail software panel**: on the computer detail page, a panel listing the
   asset's tracked software with an empty state. Satisfies **AC-6**.

## Consequences

**Positive**:
- A focused, low-noise view: only titles admins chose, so the table stays small and
  the page answers a real question (who has what, on which version).
- Reuses the existing machinery end to end (the WinRM collect, the ingest, the
  `scan:write` gate, the `assetId` keying pattern from `printer_counters`); the new
  surface is two tables, one Admin card, one page, one detail panel.
- Web-managed watchlist means no host access to change what is tracked, consistent
  with the spec 13 discovery toggles.

**Negative / tradeoffs**:
- The collector sends every named installed program for each Windows machine, even
  though only watchlist matches are kept; the filtering is web-side. On the on-prem
  LAN this payload is acceptable, but it is wasted bytes (see Follow-up for a collector
  pre-filter if it ever matters).
- Current state only: no history of when software appeared or was removed. A removal is
  only visible as its absence after the next scan, not as an event.
- A program can match more than one watchlist title (both "Office" and "Microsoft 365"
  can contain-match one DisplayName), producing a row per matched title. That is
  intended (each tracked title reports independently), but it means one program can
  count under two titles.

**Neutral**:
- Software is stored only for Computer assets, so a computer must be a matched inventory
  asset (not a discovered-inbox machine) before its software is recorded.
- Registry install dates are often blank or non-standard; they are stored as text and
  shown as-is (blank when absent), never parsed into a date type.

## Follow-up

- [ ] If the full-list payload becomes a concern at fleet scale, have the collector
  fetch the watchlist (like the discovery settings) and pre-filter before sending.
- [ ] Consider dated snapshots later if install/removal history is wanted (would add a
  history table and a retention prune, like the counter and reachability history).
- [ ] Publisher and per-user vs per-machine hive are collected but only lightly used;
  surface them in the UI if they prove useful.

## Rationale

See [rationale.md](rationale.md).
