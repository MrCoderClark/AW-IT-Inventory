# 15. Software inventory, rationale

The decision record for [15. Software inventory](index.md). `/develop` does not read
this; it is here for humans and for `/architect` on a later update.

## Context

The `Software` nav item has existed since the category views (spec 07) but leads to a
placeholder with no page and no data behind it. Spec 03 sketched a `software_item`
table long ago, but nothing was ever built, and the collector does not collect software
at all today (it gathers hardware and health over WinRM, nothing about installed
programs). So there is no way to answer basic IT questions: is Chrome deployed, which
version, on how many machines.

The fleet is all Windows, so software can only come from Windows computers (printers and
monitors have none). The collector already makes one WinRM PowerShell call per machine
and returns CIM data as JSON, so installed-software collection can ride that same call
rather than adding a new pass. The web app already has the pieces this needs: a
`machines` to `assets` match at ingest, an `assetId`-keyed reading table pattern
(`printer_counters`), a `scan:write` admin gate (discovery toggles, counter report), and
a web-managed-setting-fetched-by-the-collector pattern (spec 13). The main forces are
keeping the data useful rather than noisy, and reusing that machinery rather than
inventing new surfaces.

## Options considered

### Option 1: Full installed-software inventory

Collect every installed program from every scanned machine and store it all, filtering
only in the UI.

**Pros**:
- Complete: nothing is missed, and the tracked set can change later without re-collecting.

**Cons**:
- A large, noisy table (Windows uninstall keys are full of KB updates, redistributables,
  and system components); the aggregate view is dominated by junk unless heavily filtered.
- More storage and a retention concern for data that is mostly irrelevant to asset
  management.

### Option 2: Curated, web-managed watchlist (chosen)

Track only admin-chosen titles. A web-managed `tracked_software` list is read at ingest;
each machine's collected programs are matched by case-insensitive substring; current
matches are stored per Computer asset. The `/software` view aggregates by tracked title.

**Pros**:
- Focused and low noise: the table holds only what admins chose, so `/software` answers a
  real question (who has this title, on which versions) instead of listing thousands of
  entries.
- Reuses the existing machinery end to end (WinRM collect, ingest match, `scan:write`
  gate, `assetId` keying); the new surface is small.
- The watchlist is managed in the app, matching the spec 13 discovery toggles, so no host
  access is needed to change what is tracked.

**Cons**:
- Misses anything not on the watchlist; unexpected or rogue software is invisible until
  someone adds a title.
- Contains-matching can make one program count under two titles (for example "Office" and
  "Microsoft 365").
- Current state only: no record of when software appeared or was removed.

### Option 3: Collector-config allowlist

Put the tracked titles in `collector/config.yaml` (like `counter_oids`) and filter at the
collector.

**Pros**:
- Simplest to build: no watchlist table and no Admin UI; the collector just applies a list.

**Cons**:
- Not app-managed: changing what is tracked needs host access and a config edit, and the
  list is invisible in the UI.
- Inconsistent with the spec 13 pattern, where the app owns discovery settings and the
  collector reads them.

## Rationale

Option 2 fits how IT actually uses this. Admins care about specific titles and their
version spread (is everyone on the current Chrome, is the old AV gone), not a forensic
audit of every binary, so a curated watchlist gives a more useful page than a full dump
(Option 1) with far less noise and storage. Web-managing the list follows the spec 13
choice already made for discovery settings: control belongs in the app, not in files on
the collector host, which rules out Option 3.

Keeping it current-state (no history) matches how hardware and health are already stored
and avoids a second history table and prune job; the Follow-up notes snapshots as a later
option if removal history is wanted. Keying `installed_software` on `assetId` (not the
`machines` row) matches `printer_counters` and makes the "only inventoried computer
assets" rule fall out naturally: an unmatched machine has no asset, so it contributes
nothing. Filtering to the watchlist web-side, rather than at the collector, keeps the
collector simple and the watchlist single-sourced in the web DB; the cost is a larger
scan payload, which is fine on the on-prem LAN and is called out as a Follow-up if it
ever matters.
