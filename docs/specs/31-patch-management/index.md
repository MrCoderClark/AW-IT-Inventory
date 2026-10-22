# 31. Patch management — Windows update inventory, then missing, then install

> Third RMM-core spec after the [roadmap](../28-rmm-roadmap/index.md) (decision **A**).
> It builds on the computer scan ([spec 12](../12-scheduled-manual-scans/index.md)),
> Windows Update *age* already on compliance ([spec 21](../21-compliance/index.md)),
> and the software-deploy pipeline ([spec 23](../23-software-deployment/index.md))
> for a later install phase. **OS updates** and **optional app upgrades** (winget)
> are both inventory in v1; installing either is later. Spec 23 stays the path
> for a one-off packaged installer we already trust.

## Summary

Compliance already knows *how stale* a PC's last successful Windows Update is
(`updates_last_days`) and scores it. Admins still cannot see **which KBs are
installed**, whether the box **needs a reboot**, or (later) **what is missing**
and push it. `updates_pending` exists on `compliance_status` and is always null.

This spec adds a real **patch inventory** on the existing WinRM scan, a per-computer
Updates tab, and a fleet `/patches` page: Windows KBs + pending reboot, and
**optional app upgrades** from winget (Chrome, etc. that spec 15 already sees
installed but cannot tell are behind). Searching Windows Update for missing
OS patches, and *installing* OS or app updates, are later phases — WUA Search
already hangs scans unless it is time-boxed (spec 21), `winget.exe` is flaky
over WinRM, and installing over WinRM is a different reliability problem from
listing.

Scope v1: **Computer** assets, **installed hotfixes + pending reboot + winget
upgrade list** (best-effort), current state (replaced each successful scan), no
history table.

## Principles

- **See before you push.** v1 is inventory. An install button that fires
  `Microsoft.Update.Installer` over WinRM is phase 3, after we can name the
  missing KBs and after a job can survive a reboot.
- **Reuse the computer scan, not a 15-minute loop.** Patches change on a
  days-to-weeks cadence. Folding this into the existing WinRM collect (a *new
  small script*, because `PS_COLLECT` / `PS_POSTURE` are already at the command-line
  length cap) is enough. Spec 29's metrics loop stays for gauges.
- **Cheap OS reads; bounded app reads.** Registry pending-reboot flags and
  `Win32_QuickFixEngineering` are local CIM. **Do not** call WUA `Search()` on the
  scan path in v1 — that talks to WSUS/WU, hangs, and is why `updates_last_days`
  already runs inside a 10s job. App upgrades *do* need a catalog (winget source);
  that call is a separate, time-boxed, skippable script — never `winget upgrade --all`.
- **Winget is the 3rd-party catalog, not Chocolatey.** Chocolatey is not on the
  fleet by default. Spec 15 already has installed names/versions from Uninstall
  keys but no "latest"; winget is the inbox catalog on Win11 / recent Win10.
  Prefer **`Microsoft.WinGet.Client` objects** (`Get-WinGetPackage |
  Where-Object IsUpdateAvailable`) over parsing `winget upgrade` text — the CLI
  has no JSON output and is a known WinRM footgun (AppX / session). If the client
  is missing, **install it** (AC-9) so the next list can run; if that bootstrap
  fails, store "not available" and move on. Never `winget upgrade --all`.
- **Don't rewrite compliance.** The "last update N days ago" check and `/compliance`
  tiles stay. This spec *adds* the KB list and pending reboot; it may later *fill*
  `updates_pending` once Search is proven.

## Requirements

- **AC-1**: After a successful Windows hardware collect, the collector runs a
  **separate, best-effort** WinRM script (`PS_UPDATES`) that reads **pending reboot**
  (CBS / WU / Session Manager registry flags) and the **installed hotfix list**
  (`Win32_QuickFixEngineering`: HotFixID, description, installed-on). A failure
  never fails the machine collect; unread signals are omitted (prior rows stay).
- **AC-2**: Web stores the result as **current state** on the matched Computer
  asset: one `windows_update_state` row (pending reboot + collected-at) and a
  replaced set of `windows_hotfixes` rows. Unmatched scans do not write. The ingest
  step is best-effort and never fails the machine ingest.
- **AC-3**: The computer detail page gains an **Updates** tab (`asset:read`): pending
  reboot badge, last-update age from compliance (when present), a table of
  installed KBs, and the winget upgrade list (AC-8). Empty hotfix state when this
  machine has never returned a hotfix collect.
- **AC-4**: `/patches` (`asset:read`) is a fleet view: tiles for **pending reboot**,
  **last update > 30 days** (reuse `updates_last_days`), **app upgrades waiting**,
  and **hotfix collect / winget missing**; a sortable table of computers with
  those columns. Same visibility as `/compliance` — not `user:admin` only.
- **AC-5**: No new RBAC permission in v1. Viewing is `asset:read`. A later install
  phase reuses `software:deploy` (or a new `patch:write` if we want it narrower —
  see Open questions). The collect rides the existing scan ingest; no new service
  scope.
- **AC-6**: v1 never downloads or installs an **OS update** or a **winget app
  package** (`winget upgrade` / `--all` is phase 3). The only write on the scan
  path is **bootstrapping the WinGet client itself** when it is missing (AC-9).
- **AC-7**: Hotfix IDs are stored as returned (typically `KBnnnnnn`). Duplicate
  HotFixID on one asset is collapsed. `InstalledOn` is best-effort (WMI dates are
  messy); a missing date is null, not epoch.
- **AC-8**: After the hotfix collect, a **separate, best-effort, time-boxed**
  WinRM script (`PS_APP_UPGRADES`) lists **available winget upgrades** (id, name,
  current version, available version, source). Config `collect_app_upgrades`
  (default on) can skip the whole app path (list **and** bootstrap). Timeout or
  a client that still isn't usable after AC-9 → `wingetAvailable: false` and an
  empty list; prior rows stay. Never fail the machine collect.
- **AC-9**: When `collect_app_upgrades` is on and winget is **not usable** in
  this WinRM session, the collector **installs it** before listing: ensure
  `Microsoft.WinGet.Client` is present, then `Repair-WinGetPackageManager`
  (Microsoft's supported remote/WinRM repair). Idempotent — a machine that
  already has a working client skips this. Bootstrap is time-boxed, best-effort,
  and never installs any other package. A failed bootstrap leaves
  `wingetAvailable: false`; the next scan retries.

## Decision

**Inventory on the computer scan: OS hotfixes + pending reboot, plus a skippable
winget upgrade list. UI on the computer + `/patches`.** Not a new worker interval.
Not WUA Search in v1. Not install in v1. Concretely:

- **Collector:** `PS_UPDATES` then optional `PS_APP_UPGRADES` in
  `collect_windows.py`, each after hardware success, each its own script (command
  line cap). Payload:
  `{ pending_reboot, hotfixes: [...], winget_available, app_upgrades: [...] }`.
- **Web:** ingest upserts `windows_update_state`, replaces `windows_hotfixes` and
  `app_upgrades`. Helpers in `src/db/patches.ts`.
- **UI:** Updates tab (Windows + Apps sections) + `/patches` fleet page with both
  tiles, patterned on Compliance.

**Why bootstrap winget but not `winget upgrade --all`:** the client is
infrastructure for the catalog; Chrome is not. `--all` as the scan user can
upgrade the wrong identity's packages, prompt, or reboot. `Get-WinGetPackage`
(objects) beats parsing CLI tables.

## What we already have (do not rebuild)

| Signal | Where | Gap this spec fills |
|---|---|---|
| Days since last successful WU | `compliance_status.updates_last_days` (WUA *history*, 10s cap) | none — reuse on the Updates tab and `/patches` |
| Pending update *count* | `compliance_status.updates_pending` (always null) | phase 2 Search can fill this |
| OS name / version / build | computer collect | context on `/patches` |
| 3rd-party programs (installed) | spec 15 uninstall keys | **available upgrades** via winget (this spec) |
| Push an installer / `.msu` | spec 23 Software Library | phase 3 option for a specific KB or app |

## Data model (web DB `aw_it_inventory_web`, Drizzle)

```
windows_update_state
  asset_id            uuid pk → assets.id (cascade)
  pending_reboot      boolean | null
  hotfix_count        integer not null default 0
  winget_available    boolean | null     -- null = app collect skipped
  app_upgrade_count   integer not null default 0
  collected_at        timestamptz not null

windows_hotfixes
  asset_id         uuid → assets.id (cascade)
  hotfix_id        text not null      -- e.g. KB5034441
  description      text               -- "Security Update", "Update", …
  installed_on     date | null
  primary key (asset_id, hotfix_id)

app_upgrades
  asset_id         uuid → assets.id (cascade)
  package_id       text not null      -- e.g. Google.Chrome
  name             text not null
  version          text               -- installed
  available        text               -- winget latest
  source           text               -- winget | msstore | …
  primary key (asset_id, package_id)
```

`windows_update_state` also stores `winget_available boolean | null` and
`app_upgrade_count integer` for fleet tiles. Hotfix and app-upgrade child rows
are replaced in the same ingest transaction as the state row.

Pending-reboot sources (any one true → true):

- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`
- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`
- `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\PendingFileRenameOperations`

## Collector

New `PS_UPDATES` (sketch; keep it tiny):

- Pending reboot: test the three registry keys above.
- Hotfixes: `Get-CimInstance Win32_QuickFixEngineering` → HotFixID, Description,
  InstalledOn (ISO date or null).
- Time-box with the existing collect timeout; never call
  `Microsoft.Update.Session` in v1.

New `PS_APP_UPGRADES` (optional; `collect_app_upgrades`, default on):

1. **Check.** If `Get-WinGetPackage` (or a working `winget.exe` in this session)
   already works, skip install.
2. **Ensure (AC-9).** If not: register Desktop App Installer for this session if
   it is already provisioned (`Add-AppxPackage -RegisterByFamilyName …`); if
   still missing, `Install-Module Microsoft.WinGet.Client -Force` (PSGallery)
   then `Repair-WinGetPackageManager` (downloads the stable App Installer).
   Only the WinGet client — never another package.
3. **List.** `Get-WinGetPackage | Where-Object IsUpdateAvailable` → id, name,
   version, available, source.
4. **Time-box** the whole script (~60s: bootstrap can download). Timeout or
   still-unusable client → `{ winget_available: false, app_upgrades: [] }`.
5. Never parse `winget upgrade` ASCII tables as the primary path (no JSON CLI;
   progress junk in captured output).

Payload rides the existing `/api/ingest/scan` computer object (additive JSON).
No new ingest route.

**Honest limits:**

- On Windows 10/11, QFE is often a *partial* list; monthly cumulatives may not
  all appear. Combined with `updates_last_days` + OS build it is still the right
  OS v1 picture. Phase 2 WUA Search is the real "what's missing" OS source.
- Winget only sees packages it can match to a source. Per-user installs vs our
  local-admin WinRM identity will miss some. Machines that block PSGallery /
  App Installer / outbound CDN show "winget unavailable" after a failed
  bootstrap, not an error; the next scan retries.

## UI

- **Computer detail → Updates tab** (next to Monitoring / Compliance): pending
  reboot, last-update age, KB table, and an **App upgrades** table (package,
  current → available). Empty / "winget not available on this PC" when the
  collect skipped.
- **`/patches`**: HeroHeader + tiles (pending reboot, stale OS, app upgrades
  waiting, winget missing) + table of computers. Nav under Manage, `asset:read`
  (no extra perm), like Compliance.
- Computers table: pending-reboot badge when known (phase 4 / AC-22).

## Phases / build plan

1. **Inventory** — `PS_UPDATES` + optional `PS_APP_UPGRADES` (ensure winget +
   list), tables, ingest, Updates tab, `/patches`. **AC-1–9.** ✅ shipped.
2. **OS missing** — dedicated daily WUA Search; Missing UI + `/patches` tile.
   **AC-10–14.** ✅ shipped.
3. **Install** — approve selected OS KBs + winget upgrades from Updates tab.
   **AC-15–20.** ✅ shipped.
4. **Closeout** — see **Phase 4** below. **AC-21–22.** (this branch)

**v1 status: complete** once phase 4 ships — inventory → missing → install →
one-host Check for updates + pending-reboot chip.

## Phase 2 — Missing OS updates (WUA Search)

Phase 1 answers "what's installed / reboot needed / app upgrades." Phase 2 answers
**which OS updates are missing** without putting `Microsoft.Update.Session.Search`
on the full computer scan (that hangs; we already isolate WUA *history* in a 10s
job on posture).

### Decision

**Dedicated worker loop** (same shape as spec 29 metrics): for each known Computer
with an IP, one time-boxed WinRM script that runs WUA
`Search("IsInstalled=0")`, posts missing KBs + count. **Not** on `PS_COLLECT` /
`PS_UPDATES`. Cadence is **daily** by default (`missing_patch_interval_hours: 24`,
`0` = off) — Search talks to WSUS/WU and is expensive; hourly is wrong. Manual
"Scan now" does **not** trigger Search (keeps Scan snappy). Phase 4 adds an
optional one-host **Check for updates** button on the Updates tab.

### Requirements (phase 2)

- **AC-10**: The collector worker runs a scheduled missing-patch pass over every
  computer target (same target list as metrics / computer sweep). Per host: WinRM
  `PS_MISSING_UPDATES` creates `Microsoft.Update.Session`,
  `CreateUpdateSearcher().Search("IsInstalled=0")`, returns
  `{ missing: [{ kb, title, severity, size_bytes }], count }` (KB from
  `KBArticleIDs` / title parse; severity from `MsrcSeverity` when present). Whole
  script wall-clock capped (`missing_patch_timeout`, default **120s**). Timeout /
  COM failure → skip that host (prior missing rows stay); never fail the loop.
- **AC-11**: Web stores current state: replace `windows_missing_updates` for the
  matched Computer; set `windows_update_state.missing_count` + `missing_collected_at`;
  set `compliance_status.updates_pending` to the count (so compliance / reports
  finally see a real pending number). Unmatched IPs do not write. Best-effort ingest.
- **AC-12**: Updates tab gains a **Missing** section (KB, title, severity) above or
  beside installed KBs. Empty = none missing or never searched. `/patches` gains a
  tile + column for **OS updates missing** (count).
- **AC-13**: Still **no install** in phase 2 (AC-6 unchanged). Search is read-only
  against the update service; it does not download or install.
- **AC-14**: Config: `missing_patch_interval_hours` (default 24, 0 = off),
  `missing_patch_timeout` (default 120). No new RBAC / service scope — rides
  existing scan/ingest credentials (`ingest:write` / computer target read).

### Data model (additive)

```
windows_update_state  (extend)
  missing_count          integer not null default 0
  missing_collected_at   timestamptz | null

windows_missing_updates
  asset_id      uuid → assets.id (cascade)
  kb_id         text not null      -- KBnnnnnn when known; else a stable title hash/id
  title         text not null
  severity      text               -- Critical | Important | … | null
  size_bytes    bigint | null
  primary key (asset_id, kb_id)
```

`compliance_status.updates_pending` is written on successful Search ingest (integer
≥ 0). A failed/skipped Search does **not** null it out.

### Collector sketch

`collect_missing_updates.py` (metrics twin): fetch computer targets → thread pool →
per-IP `PS_MISSING_UPDATES` via `_run_ps_timeout` → `POST /api/ingest/missing-updates`
(or additive fields on an existing ingest if cleaner). Worker schedules
`hours=missing_patch_interval_hours`. Startup log: `missing-patches every 24h`.

Honest limits: Search needs network to WSUS/WU; offline / blocked hosts stay at
prior state. Some updates have no KB id (store title-derived key). Driver-only /
optional updates may appear depending on Search criteria — v1 uses
`IsInstalled=0` only (no `IsHidden=0` filter unless we learn we need it).

### UI

- Computer **Updates** → Missing table + count badge.
- `/patches` → tile "OS updates missing" + table column.
- Compliance score rubric unchanged in phase 2 (still ages on `updates_last_days`);
  filling `updates_pending` unlocks a later score tweak if we want it.

## Phase 3 — Install selected OS KBs + winget upgrades

Phase 1–2 answer "what's installed / what's missing." Phase 3 lets an admin
**approve and install** selected items on one computer from the Updates tab.

### Decision

**Dedicated `patch_install_jobs` queue** (same outbound-only claim/status/reaper
shape as spec 23 software deploy). Updates tab only: checkboxes on Missing OS
rows and App upgrades → **Install selected**. Permission: reuse
`software:deploy`. Service scope: reuse `deploy:agent`. **No auto-reboot.**
Never `winget upgrade --all`. No fleet bulk from `/patches` in this phase.
Credentials never stored on the job row (collector resolves WinRM profiles at
run time).

OS path: WUA `Search` → match by KB / UpdateID → Download → Install (read-only
Search from phase 2 stays on the daily loop; install is a separate job). App
path: `winget upgrade --id <id> --silent --accept-package-agreements
--accept-source-agreements --disable-interactivity` via the same InstallLocation
winget resolution as the list script.

### Requirements (phase 3)

- **AC-15**: Admin with `software:deploy` can enqueue an install from a Computer's
  Updates tab for a non-empty selection of current missing OS `kb_id`s and/or
  winget `package_id`s. Selection is validated against stored inventory at
  enqueue; unknown ids are rejected. Soft one-in-flight-per-computer (pending /
  claimed / running). Requires Computer + IP (same as deploy).
- **AC-16**: Job row freezes `selection` jsonb
  `{ os: [{ kbId, title }], apps: [{ packageId, name, version, available }] }`
  plus `targetIp` / `requestedBy`. No passwords. Status machine matches deploy:
  `pending` → `claimed` → `running` → `succeeded` | `failed` | `canceled`.
- **AC-17**: Collector worker claims via `/api/patch-install/claim`, runs OS then
  app items over WinRM, posts `/api/patch-install/{id}/status` under the claim
  fence. Whole job wall-clock capped (`patch_install_timeout`, default **600s**).
  Per-item results in `result` jsonb; job-level errors in `error`. WUA / winget
  reboot-required exit maps to item success with `rebootRequired: true` — **do
  not** reboot the host.
- **AC-18**: Updates tab: checkboxes + Install selected (confirm dialog stating
  no reboot) + in-flight / history list (who, when, status, item counts). Cancel
  while pending/claimed. Hidden / disabled without `software:deploy`.
- **AC-19**: On terminal status, notify like a software deploy (`notifyDeployResult`
  or a thin patch twin). Inventory refresh is best-effort / next scan+Search —
  install does not itself rewrite missing/upgrade tables in v1.
- **AC-20**: Config: `patch_install_timeout` (default 600). No new RBAC perm; no
  new service scope. AC-6 is superseded for *approved* installs only — Scan now
  and the daily Search remain read-only.

### Data model (additive)

```
patch_install_jobs
  id            uuid pk
  asset_id      uuid → assets.id (cascade)
  target_ip     text not null
  selection     jsonb not null   -- frozen { os[], apps[] }
  status        text not null default 'pending'
  requested_by  text not null
  worker_id     text | null
  claimed_at / started_at / finished_at  timestamptz | null
  result        jsonb | null     -- { items: [{ kind, id, ok, rebootRequired, exitCode, outputTail }], rebootRequired }
  error         text | null
  created_at / updated_at
  partial index: pending claim poll; in-flight per assetId
```

### Collector sketch

`patch_install.py` + `_drain_patch_install` in the worker (alongside deploy).
Claim → mark running → resolve profiles → for each OS item run a time-sliced
WUA install script; for each app run winget upgrade `--id`. Always clean up;
post fenced status. Startup: no new schedule line (on-demand only).

### UI

- Computer **Updates** → checkboxes on Missing + App upgrades; Install selected;
  job history.
- `/patches` unchanged (counts only) in phase 3.

## Phase 4 — Closeout (v1 finish)

Polish that closes the "Scan now stays fast / Search is separate" story and the
fleet visibility gap called out in phase 1.

### Requirements (phase 4)

- **AC-21**: Updates tab **Check for updates** (`software:deploy`) enqueues a
  one-host missing Search job (same `PS_MISSING_UPDATES` +
  `/api/ingest/missing-updates` as the daily loop). Not on Scan now. Soft
  one-in-flight-per-computer for checks. Worker claims via
  `/api/missing-update-checks/claim` (`deploy:agent`); posts status then ingest.
- **AC-22**: Computers table shows a compact **Pending reboot** badge next to
  the name when `windows_update_state.pending_reboot` is true.

### Out of scope / v2 (not this spec)

**First v2 slice:** [Fleet OS multi-install from `/patches`](../../superpowers/specs/2026-10-22-spec-31-v2-fleet-os-install-design.md) — multi-select computers, enqueue all missing OS updates per host, global concurrency cap. Implemented on `feat/spec-31-v2-fleet-os-install` (🚧 until merge).

Still deferred — do not block marking 31 complete:

- Optional "reboot when done" on install jobs
- WSUS / target-group scoping
- `.msu` install via Software Library (use spec 23 for packaged push)
- Spec 30 built-in rules for pending reboot / missing / app-upgrade counts
- Win10/11 DISM package list if QFE stays thin; `IsHidden=0` Search filter

## Consequences

- One or two extra WinRM round-trips per computer scan (hotfixes always; winget
  if enabled). Keep both scripts small and time-boxed.
- QFE incompleteness on modern Windows is documented, not a surprise later.
- `/compliance` and `/patches` will overlap on "stale updates"; that is
  intentional (score vs inventory). Do not delete the compliance updates check.

## Decisions (closed)

- **Install permission:** reuse `software:deploy` (no `patch:write`).
- **Search cadence:** dedicated daily interval; Scan now stays inventory-only;
  AC-21 adds optional one-host Check.
- **Auto-reboot after install:** no by default (v2 flag).
- **Winget bootstrap vs GPO:** fail soft (AC-9);
  `collect_app_upgrades: false` turns the app path off.

## Related

- [28](../28-rmm-roadmap/index.md) roadmap · [21](../21-compliance/index.md)
  update age · [12](../12-scheduled-manual-scans/index.md) scan ·
  [23](../23-software-deployment/index.md) deploy · [15](../15-software-inventory/index.md)
  programs · [30](../30-alert-rules/index.md) pending-reboot / missing alerts (v2)
