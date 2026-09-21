# 13. Discovery type toggles

**Date**: 2026-09-21
**Status**: Proposed

## Summary

Admins get per-type on and off switches for what the collector automatically
discovers: Computers and Printers. The switches live on the web Admin page,
persist in the web database, and the collector reads them before each automatic
sweep and skips a type that is off (it never gets collected, ingested, or shown
in the discovered devices inbox). Manual scans started from the app ignore the
switches, so you can always scan a device you explicitly target. Turning Printers
off also pauses the scheduled printer reachability checks from spec 12.

## Requirements

**User stories**:
- As an IT admin, I want to turn off automatic discovery of a device type (say
  printers), so the collector stops finding and adding devices I do not want
  managed automatically.
- As an IT admin, I want those switches in the app (not on the collector host),
  so I can change them without editing files on a server.
- As an IT admin, I want a manual scan I start to still work even when that
  device type is switched off, so an explicit scan is never blocked by a global
  setting.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: An admin holding `scan:write` sees per-type discovery switches
  (Computers, Printers) on the Admin page and can turn each on or off. The change
  persists (upsert into `discovery_settings`) and every admin sees the same saved
  state.
- **AC-2**: With no saved row for a type, that type defaults to on, so discovery
  behaves exactly as today until an admin turns a type off. No seed row is needed.
- **AC-3**: The collector reads the switches before each automatic sweep (the
  `scan` command's subnet discovery) through `GET /api/scan/discovery-settings`,
  and skips collecting and ingesting any type that is off, so an off type never
  reaches the discovered devices inbox or inventory from that run.
- **AC-4**: A manual scan started from the app (Scan now, Scan selected, Scan all,
  the web queued jobs) ignores the switches and always scans its targeted devices,
  whatever the switch state.
- **AC-5**: When Printers is off, the collector also skips the spec 12 scheduled
  printer reachability checks; turning Printers back on resumes them. (Takes
  effect once spec 12 milestone 3, the reachability scheduler, is built.)
- **AC-6**: If the collector cannot read the settings endpoint, it uses the last
  settings it fetched successfully (cached on the collector host). If it never
  cached any, it proceeds with all types on (fail open on first run only). A
  successful fetch refreshes the cache.
- **AC-7**: Editing a switch is gated on `scan:write` (the server action rechecks
  it server side). The collector read endpoint requires a service token carrying
  `scan:dequeue`. A user without `scan:write` cannot change the switches (the
  controls are hidden or read only) and the server action refuses them.
- **AC-8**: Both types may be off at once. The automatic sweep then discovers
  nothing and the collector logs a warning, while manual scans still work.

## Decision

**Chosen option**: Option 1: Web persisted settings the collector pulls before
each run.

Store the switches in the web database (`discovery_settings`, one row per type),
edit them from the Admin page (gated on `scan:write`), expose them to the
collector through a small read endpoint gated on `scan:dequeue`, and have the
collector fetch them before each automatic sweep (caching the last good result
so a settings outage does not stop scanning). The switches map onto the
collector's existing `no_windows` and `no_printers` levers, so an off type is
simply not collected. Manual queue jobs never consult the switches.

## Feature design

**Data model sketch** (web DB `aw_it_inventory`, Drizzle; one new table):

`discovery_settings` (one row per toggleable device type)
- `deviceType` text primary key: `computer` | `printer` (a typed union in TS)
- `enabled` boolean not null default true
- `updatedAt` timestamptz not null default now

An absent row means on, so the default state is all on with no seeding, and the
table starts empty. Reads coalesce a missing type to `true`.

**State transitions**: none (each row is a simple on or off flag).

**API surface**:

| Endpoint / action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `setDiscoveryToggle` (server action) | action | deviceType, enabled | ok | cookie + `scan:write` | 403 no perm, 422 bad type |
| `GET /api/scan/discovery-settings` | GET | (none) | `{ computer: bool, printer: bool }` | service `scan:dequeue` | 401, 403 |
| Admin page read | server component | (none) | current switches | cookie (`scan:read` to view) | — |

The Admin page reads the switches straight from the DB in a server component (no
extra read endpoint), the same way the jobs view does.

**Key invariants**:
- Absent row = on. The read helper and the endpoint coalesce a missing type to
  `true`, so the empty table equals "discover everything".
- The switches govern only the automatic sweep (the `scan` command) and the
  scheduled reachability run. Web queued manual jobs never read them (AC-4).
- Off means skipped at collection time: the collector does not collect or ingest
  that type, so nothing for it reaches the inbox or inventory (not a later filter).
- The collector caches the last good settings to a local file on the collector
  host; a failed read falls back to that cache, then to all on (AC-6).
- No secrets are added. The switch values are not sensitive (on or off flags for
  an internal tool).

**Security model**:
- Edit: a signed in user with `scan:write` (Owner or Admin already hold it). The
  server action rechecks the permission server side; the UI hides or disables the
  controls without it.
- View: the Admin page renders the switches for a `scan:read` viewer; only
  `scan:write` makes them editable.
- Collector read: a service token carrying `scan:dequeue`, verified through the
  existing JWKS path the same way the other `/api/scan/*` routes verify it.
- Internal IT inventory on a private network; no regulated data, no audit
  requirement beyond the row's `updatedAt`.

**Configuration required**:
- None new. The collector reuses its existing service credentials and web base
  URL. It writes a cache file (for example `collector/.discovery-settings.json`,
  gitignored) holding the last good settings; this is not a secret.

**Critical test scenarios** (each maps to an AC in Requirements):
- Happy path: an admin turns Printers off; the next `scan` run skips SNMP
  collection and ingests no printers, and no printer appears in the inbox from
  that run. Verifies AC-1, AC-3.
- Default on: a fresh install with an empty `discovery_settings` table discovers
  both types exactly as today. Verifies AC-2.
- Manual bypass: with Computers off, an admin clicks Scan now on a computer; the
  worker still scans and ingests it. Verifies AC-4.
- Settings outage: the web app is down when the collector starts a sweep; it uses
  the cached settings (or all on if none cached) and does not crash. Verifies AC-6.
- Auth: a user without `scan:write` sees the switches read only and the server
  action refuses them; a service token missing `scan:dequeue` is rejected by the
  read endpoint. Verifies AC-7.

## Build plan

Build approach: Tracer Bullet (the project default, per spec 12). A thin thread
runs end to end first (store a switch, the collector reads it and skips a type),
then the Admin UI and the reachability link thicken it.

1. Data layer. Add `discovery_settings` to `web/src/db/schema.ts` and run
   `db:push`. Add a small `web/src/db/discovery.ts` with `getDiscoverySettings()`
   (coalescing an absent type to `true`) and `setDiscoveryToggle()` (upsert).
   Satisfies **AC-2**, **AC-1** (data).
2. Read endpoint. `GET /api/scan/discovery-settings`, service token gated on
   `scan:dequeue`, returning `{ computer, printer }`. Satisfies **AC-3**
   (foundation), **AC-7** (endpoint auth).
3. Collector honors it. Add `get_discovery_settings(config)` in the collector: it
   fetches the endpoint, caches the result to a local file on success, and on a
   read failure loads the cache (or all on if none). The `scan` command applies it
   as `no_windows` / `no_printers`; manual queue jobs (`worker._run_job`) bypass
   it. Log a warning when both are off. Satisfies **AC-3**, **AC-4**, **AC-6**,
   **AC-8**.
4. Admin UI. A Discovery section on `/admin` with the two switches, a
   `setDiscoveryToggle` server action gated on `scan:write`, hidden or read only
   without it. Satisfies **AC-1**, **AC-7**.
5. Reachability link. Gate the spec 12 scheduled printer reachability run on the
   Printers switch. If that scheduler is not built yet (spec 12 milestone 3), add
   the gate as part of building it; otherwise add it here. Satisfies **AC-5**.

## Consequences

**Positive**:
- Admins control automatic discovery from the app, no editing files on the
  collector host.
- Off is enforced at collection time, so an off type costs no scan work and never
  clutters the inbox.
- Reuses the collector's existing `no_windows` / `no_printers` levers and the
  existing service token path, so the change is small and low risk.
- Default on with an empty table means zero behavior change until an admin opts in.

**Negative / tradeoffs**:
- One more moving part: the collector now depends on a web read before each sweep.
  The cache plus fail open keeps an outage from stopping scanning, but the cache
  can be briefly stale (a switch flipped during an outage is not seen until the
  next successful fetch).
- The `scan` command now honors the global switches by default, so a human running
  it on the host gets the app's setting, not a blank slate. The existing
  `--no-windows` / `--no-printers` flags still narrow a run, but there is no per
  run "ignore the switches" override in v1 (see Follow-up).
- AC-5 depends on spec 12 milestone 3 (the reachability scheduler), which is not
  built yet, so that criterion cannot be verified until then.

**Neutral**:
- A new collector cache file to gitignore.
- The switch set is fixed at two types (Computers, Printers) because those are the
  only types the collector classifies today; adding a type later is a small change
  (a new allowed `deviceType` value plus a UI row).

## Follow-up

- [ ] Consider a `--ignore-discovery-settings` flag on the `scan` command for a
  one off host run that should ignore the global switches.
- [ ] AC-5 (the reachability link) depends on spec 12 milestone 3; wire the gate
  when that scheduler is built, and verify AC-5 then.
- [ ] If phone, monitor, or network scanning is added later, extend the switch set
  and the `deviceType` union to cover them.

## Rationale

Reasoning, the options weighed, and the full context: see [rationale.md](rationale.md).
