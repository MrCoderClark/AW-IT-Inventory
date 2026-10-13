# 25. Connected monitors — display inventory from the scan

**Date**: 2026-10-12
**Status**: Proposed

## Summary

OPUS learns which **monitors are physically connected to each computer**, read from
the display's **EDID over the existing WinRM scan** — no agent, no new access. Each
attached display yields its **manufacturer, model, serial number, year of
manufacture, and active state**; these are stored per Computer and shown as a
**Displays** list on the computer's detail page. Because OPUS already tracks
**Monitor assets by serial**, a scanned serial is then **reconciled** against those
assets — auto-surfacing "this monitor is connected to `<PC>`" and flagging monitors
seen on a PC that OPUS doesn't yet have as an asset.

Verified on the fleet: a scan of a real machine returned two `DELL P2217H` monitors
with distinct serials (`4RDG973R2PWB`, `4RDG973R2QJB`) and year 2017 — clean,
serial-level data over the channel OPUS already uses.

> **Honest scope note.** EDID is **best-effort**: a headless machine, one with no
> active display, or a virtual/DisplayLink/RDP adapter can return an empty list or a
> serial-less "Generic PnP Monitor". The feature surfaces that as "no displays
> detected" rather than failing — the same honest unknown-vs-value posture as the
> spec-21 compliance signals.

## Requirements

**User stories**:
- As an IT admin, I want to see which monitors are attached to a computer without
  walking to the desk, so I can inventory displays remotely.
- As an IT admin, I want a scanned monitor's serial matched to its Monitor asset, so
  monitor-to-computer assignment is discovered automatically instead of entered by
  hand.
- As an IT admin, I want to notice monitors in use that OPUS doesn't track, so I can
  add them.

**Acceptance criteria**:
- **AC-1**: The WinRM collect reads connected displays in the **same
  `collect_windows` PowerShell round-trip** (best-effort, progress suppressed). A
  read failure yields an **empty list for displays only** and never aborts the
  machine collect.
- **AC-2**: Each display is decoded from EDID to `{ manufacturer, model, serial,
  productCode, year, active }` — the manufacturer's 3-letter **PnP code mapped to a
  vendor name** (`DEL`→Dell, `SAM`→Samsung, `GSM`→LG…), falling back to the raw code.
  A blank/garbage serial or a "Generic PnP Monitor" normalizes to no serial.
- **AC-3**: Displays are stored **per Computer asset as current state, no history**
  (like `installed_software`): the set is fully replaced on each scan in a
  transaction; `monitors == null` (not read) leaves the prior set intact; a
  non-Computer stores nothing. A display write never fails the machine ingest.
- **AC-4**: The computer detail page shows a **Displays** list — model, serial, year,
  and an active indicator — to any `asset:read` viewer; "no displays detected" when
  the set is empty.
- **AC-5** (phase 2): A scanned serial that **matches a Monitor asset's serial**
  links them: the Displays row links to that Monitor asset, and the Monitor asset's
  detail page shows **"Connected to `<computer>`"** (computed by the serial join; no
  extra stored link).
- **AC-6** (phase 2): A scanned serial with **no matching Monitor asset** is flagged
  as unknown ("not in inventory"), a discovery hint the admin can act on.
- **AC-7**: Viewing is open to `asset:read`; no new permission and no collector scope
  change (it rides the existing ingest path).

## Decision

**Chosen option**: Extend the agentless `collect_windows` WinRM collect with an EDID
read (`Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID`, plus
`WmiMonitorBasicDisplayParams` for physical size), decode each display web-side or
collector-side, carry it on `HostResult.monitors`, and upsert a `connected_monitors`
table at ingest — mirroring the software-inventory (spec 15) and compliance
(spec 21) collect→store→surface pattern. Reconciliation against Monitor assets is a
**read-time serial join**, not new stored state.

This reuses the one WinRM round-trip (no extra connection), keeps the posture
honest (empty/unknown vs a list), and adds no new permission, scope, or inbound
surface. Alternatives (a separate WMI call per host, parsing raw EDID bytes
ourselves, or storing an explicit monitor↔computer link) are weighed in
[rationale.md](rationale.md).

## Signals collected (how + what we store)

Read in the existing `collect_windows` call, wrapped so a failure yields `null`:

| Source (PowerShell) | Fields |
|---|---|
| `Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID` | `ManufacturerName` (3-letter PnP), `UserFriendlyName` (model), `SerialNumberID`, `ProductCodeID`, `YearOfManufacture`, `WeekOfManufacture`, `Active` — each a UInt16[] decoded to a string |
| `Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams` (best-effort) | `MaxHorizontalImageSize` / `MaxVerticalImageSize` (cm) → diagonal inches |

Decoded per display to `{ manufacturer, vendorCode, model, serial, productCode,
year, active, diagonalIn? }`. The **PnP→vendor** map is a constants table (a curated
subset of the UEFI/EISA PnP ID registry); an unmapped code shows as the raw code.

## Data model (web DB `aw_it_inventory`, Drizzle; one new table)

`connected_monitors` — current state per Computer, fully replaced per scan.
- `id` uuid pk
- `assetId` uuid not null → `assets.id` on delete cascade
- `manufacturer` text (vendor name) · `vendorCode` text (3-letter PnP)
- `model` text · `serial` text null · `productCode` text null
- `year` integer null · `active` boolean
- `diagonalIn` numeric null
- `seenAt` timestamptz not null default now
- index (`assetId`); index (`serial`) for the Monitor-asset reconciliation join

**Needs `npm run db:push`.** No aw-auth change.

## API / ingest

No new endpoints. The collector adds `monitors` to each `HostResult`; on
`/api/ingest/scan`, a matched **Computer** with a `monitors` array replaces its
`connected_monitors` rows in a transaction (best-effort). Read helpers live in a
`server-only` `src/db/monitors.ts`: `getConnectedMonitors(tag)` (detail card) and,
for phase 2, `resolveMonitorAssetBySerial` / `getComputerForMonitor(serial)`.

## UI

- **Computer detail → Displays** (`asset:read`): a card/section listing each attached
  monitor (model, serial, year, active). Phase 2: each row links to its Monitor
  asset when the serial matches, or shows a "not in inventory" chip.
- **Monitor asset detail** (phase 2): a "Connected to `<computer>`" line when a
  computer scan reports this monitor's serial.

## Phases / build plan

1. **Collector + storage.** EDID read + decode in `collect_windows`, PnP→vendor map,
   `models.Monitor` → `HostResult.monitors`, `connected_monitors` table + `db/monitors.ts`
   + ingest upsert + tests. (Verify via DB/ingest.) **AC-1/2/3.**
2. **Displays card** on the computer detail page. **AC-4.**
3. **Reconcile with Monitor assets** — serial join both ways, "connected to" on the
   monitor asset, unknown-serial discovery hint. **AC-5/6.**

## Consequences

**Positive**: serial-level display inventory with zero new access or infra; automatic
monitor↔computer discovery that replaces manual assignment; a path to catching
untracked monitors. Reuses the proven collect→store→surface pattern.

**Negative / tradeoffs**: EDID is best-effort (headless/virtual/serial-less displays);
the PnP→vendor map needs occasional additions; reconciliation is only as good as the
serials both sides report (a mismatch in how a serial is recorded on the Monitor
asset vs EDID means no auto-link).

**Neutral**: one new table, a new `db/monitors.ts` module, a detail-page card, and a
small decode addition to the existing WinRM collect — all additive.

## Follow-up

- Resolution / refresh-rate and connection type (HDMI/DP) from
  `WmiMonitorListedSupportedSourceModes` / `WmiMonitorConnectionParams`.
- Auto-create a Monitor asset from an unknown scanned serial (one click).
- Display history / "monitor moved from PC-A to PC-B" events.
- Fleet "Displays" report (counts by model/vendor/age).

## Rationale

Options weighed (one WinRM call vs per-host, decode where, stored link vs read-time
join, EDID byte-parsing): see [rationale.md](rationale.md).
