# 17.03 Printers redesign: hero list + tabbed detail

Child of the [spec 17 umbrella](index.md). The flagship surface, built to the mocks
`docs/Design/mock-printers-list.png` and `mock-printers-detail-page.png`.

## Summary

Rebuild the printer list and printer detail pages to the mocks. The list gets a
photographic hero header and Manufacturer / Model / Location filters. The detail
page becomes a rich, tabbed view (Overview, Network, Counters, Checks, Activity)
with a product image, an on demand Run Check, an Open Management UI link, and a
Recent Activity feed. No new scan infrastructure: it reuses spec 12 reachability,
spec 14 counters, and child 02 images, and renders what already exists.

## Requirements

**User stories**:
- As an IT admin, I want to browse printers under a clear, filterable list so I can
  find one fast.
- As an IT admin, I want one printer detail page that shows identity, live health,
  counters, check history, and recent activity, with an on demand recheck.

**Acceptance criteria**:
- **AC-3.1**: The printers list matches the mock: a hero header with the office
  printer background image, a search box, Manufacturer / Model / Location filter
  dropdowns, the existing Columns / Export / Scan QR controls, a "New Printer"
  button, and the printer table (name, model, serial, IP, reachability, location,
  status, last sync) with its empty state.
- **AC-3.2**: The Manufacturer filter lists the distinct vendors of the printers and
  narrows the table; Model and Location filters do likewise; they combine.
- **AC-3.3**: The printer detail header matches the mock: the product image (child
  02, with a printer icon fallback), a PRINTER badge, the asset tag, the reachability
  status (Online/Offline dot), the model, and the actions Edit, Run Check, Open
  Management UI, and an overflow menu (Delete, Print label, Scan now).
- **AC-3.4**: The detail page shows five tabs, Overview / Network / Counters /
  Checks / Activity, that switch panels without navigation. Overview shows the Asset
  Information, Network Health, Printer Status, Recent Activity, and Counters cards
  from the mock.
- **AC-3.5**: Network Health shows the reachable / last checked rollup plus the
  latest TCP result WITH its latency and the latest SNMP result as reachable +
  when checked (no SNMP latency: the collector records only the TCP probe's latency,
  even on SNMP rows, so SNMP latency is not genuine data and must not be shown as
  if it were). HTTP is shown as not tracked (deferred). Counters shows the total
  page count (spec 14); Black & White / Color are shown as not tracked (deferred).
- **AC-3.6**: Recent Activity (and the Activity tab) is a time ordered feed derived
  from existing history: reachability checks become "Health Check" rows and counter
  snapshots become "Counter Sync" rows (both straight reads). "Status Update" rows
  (a printer went down or recovered) are NOT stored anywhere, so they are
  reconstructed by replaying `printer_checks` through the same `consecutiveFailures
  >= 2` down rule that `recordChecks` uses; that threshold rule is factored into one
  shared pure function both call, so the two never drift. No new table.
- **AC-3.7**: Run Check enqueues an on demand check the collector runs (reusing the
  spec 12 manual scan path for this printer); the button shows progress and the page
  reflects the result on refresh. Because the manual path probes TCP only (SNMP is
  refreshed by the daily sweep), the Network tab says so plainly ("Run Check
  refreshes TCP reachability; SNMP and counters refresh on the daily sweep") so the
  asymmetry is not silent. Open Management UI opens the printer's management URL in a
  new tab, and is disabled when the printer has none.
- **AC-3.8**: Every mutation control (Run Check, Scan now, Edit, Delete, image
  upload) requires `asset:write` / `scan:write` as its action already does; viewing
  the page and all tabs is open to `asset:read`.

## Decision

**Chosen option**: rebuild the two printer pages to the mocks using the child 01
`HeroHeader` and `Tabs`, render the new panels from existing spec 12 / spec 14 data
plus child 02 images, add a derived activity read helper, and wire Run Check to the
existing collector scan path. Manufacturer is the existing `vendor` field.

**Rationale (inline)**: the mocks add presentation and reorganization, not new
telemetry; the reachability history, counter history, and status rollup OPUS already
stores cover Network Health, Counters, Checks, and Activity once reshaped, so the
build is UI plus read helpers, not a collector change. Run Check reuses spec 12 so
the web app still never reaches into the fleet. HTTP per protocol and the mono/color
counter split are shown as "not tracked" rather than faked, keeping them the honest
spec 12 / spec 14 follow ups.

## Feature design

**Data model**: no new tables or columns beyond child 02's `imageKey`. Reads use
spec 12 `printer_checks` / `printer_status`, spec 14 `printer_counters`, and the
`printer_details` `mgmtUrl` (Open Management UI).

**New read helpers** (`server-only`, `src/db/`):
- `getPrinterNetworkHealth(tag)`: the reachability rollup plus the latest TCP check
  (reachable + latency) and the latest SNMP check (reachable + checked time only, no
  latency, since the collector never times SNMP) from `printer_checks`; HTTP marked
  not tracked.
- `getPrinterActivity(tag, limit)`: a merged, time sorted feed from `printer_checks`
  (Health Check, straight read), `printer_counters` (Counter Sync, straight read),
  and reconstructed down/recovery events (Status Update). The transitions are not
  stored, so this replays `printer_checks` through the shared down rule (see below)
  to find flips. Shared by the Overview "Recent Activity" card (top few) and the
  Activity tab (full, paged).
- `isDown(consecutiveFailures)` / the `>= 2` threshold: extract the spec 12 down
  rule (today inline in `recordChecks`) into one shared pure function that both
  `recordChecks` and the activity replay call, so they cannot drift.

**Tabs**:
| Tab | Content | Source |
|---|---|---|
| Overview | Asset Information, Network Health, Printer Status, Recent Activity, Counters cards | reused reads |
| Network | IP, per protocol latest (TCP/SNMP live, HTTP not tracked), reachability history, Run Check | spec 12 |
| Counters | total page counter, daily deltas, recent history | spec 14 |
| Checks | full reachability check history + Run Check | spec 12 `printer_checks` |
| Activity | full derived activity feed | the helper above |

**API surface** (server actions / routes; mostly reused):
| Action | Inputs | Auth | Notes |
|---|---|---|---|
| `runPrinterCheckAction` | asset tag | `scan:write` | enqueues a scan of this printer via the existing `requestScan("selected", [tag])`; the collector runs it and posts reachability/counter results the normal way |
| Open Management UI | — | `asset:read` | a link to `printer_details.mgmtUrl`, new tab; disabled when null |
| Edit / Delete / Scan now / image upload | (existing) | (existing gates) | reuse the asset form, delete, scan, and child 02 upload |

**Key invariants**: Run Check creates no new scan mechanism; it is the spec 12
manual scan scoped to one printer. The activity feed is read only and derived; it
never writes.

**Security model**: unchanged from today; each action keeps its current gate
(`asset:write` for edit/delete/image, `scan:write` for Run Check / Scan now),
viewing open to `asset:read`.

**Critical test scenarios**:
- List: Manufacturer/Model/Location filters narrow and combine; empty state shows,
  verifies **AC-3.1**, **AC-3.2**.
- Detail: the five tabs render and switch; Network Health shows TCP+SNMP latency and
  HTTP "not tracked"; Counters shows the total, verifies **AC-3.4**, **AC-3.5**.
- Activity: a printer with checks + counter snapshots + a down/up transition shows
  all three event kinds in time order, verifies **AC-3.6**.
- Run Check: the action enqueues a scan for the printer (spec 12) and reports
  progress; Open Management UI is disabled with no mgmtUrl, verifies **AC-3.7**.
- Auth: an `asset:read` user sees the page and tabs but no Run Check / Edit / Delete
  controls, verifies **AC-3.8**.

## Build plan

1. Read helpers: extract the shared `>= 2` down rule from `recordChecks`, then build
   `getPrinterNetworkHealth` (TCP latency real, SNMP time only) and
   `getPrinterActivity` (straight reads for Health Check / Counter Sync, a replay of
   `printer_checks` through the shared rule for Status Update) over the existing spec
   12 / spec 14 tables. Satisfies **AC-3.5**, **AC-3.6**.
2. Printers list: `HeroHeader` with the background image, Manufacturer (distinct
   vendor) / Model / Location filters wired into the table, "New Printer" label,
   keeping Columns / Export / Scan QR and the reachability column. Satisfies
   **AC-3.1**, **AC-3.2**.
3. Printer detail header + shell: product image (child 02 + fallback), PRINTER badge,
   tag, status, model, the action buttons (Edit, Run Check, Open Management UI,
   overflow) and the `Tabs` strip. Satisfies **AC-3.3**, **AC-3.4** (shell).
4. Overview tab: Asset Information, Network Health, Printer Status, Recent Activity,
   Counters cards to the mock. Satisfies **AC-3.4**, **AC-3.5**.
5. Network, Counters, Checks, Activity tabs. Satisfies **AC-3.4**, **AC-3.5**,
   **AC-3.6**.
6. `runPrinterCheckAction` (reuse `requestScan` for the printer) + the Open
   Management UI link. Satisfies **AC-3.7**.
7. Tests: filters, tab render, activity merge, Run Check gating, auth. Satisfies the
   automatable ACs.

## Consequences

**Positive**: a best in class printer page with no new collector work; the tab +
card framework it establishes is what child 04 rolls out.

**Negative / tradeoffs**: HTTP reachability and the mono/color split are visibly
"not tracked" until their spec 12 / spec 14 follow ups land; some users may expect
them from the mock.

**Neutral**: Run Check is a thin wrapper over the existing manual scan, so its
latency is the collector's poll interval, not instant.
