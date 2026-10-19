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
- Computers table: optional later chip for pending reboot — not v1.

## Phases / build plan

1. **Inventory** — `PS_UPDATES` + optional `PS_APP_UPGRADES` (ensure winget +
   list), tables, ingest, Updates tab, `/patches`. **AC-1–9.** *(Needs `db:push`.)*
2. **OS missing** — time-boxed WUA `Search("IsInstalled=0")` on a **dedicated**
   worker job (not the full scan), store missing KBs + fill `updates_pending`.
3. **Install** — approve selected OS KBs (WUA Download/Install or spec-23 `.msu`)
   and/or selected winget ids (`winget upgrade --id … --silent
   --accept-package-agreements --accept-source-agreements --disable-interactivity`,
   never `--all` as a blind fleet action). Reboot-required must not leave
   credentials in the job row. Notify like a software deploy.
4. **Later:** WSUS/target-group scoping; fold "pending reboot" / "N app upgrades"
   into spec 30 as built-in rules.

## Consequences

- One or two extra WinRM round-trips per computer scan (hotfixes always; winget
  if enabled). Keep both scripts small and time-boxed.
- QFE incompleteness on modern Windows is documented, not a surprise later.
- `/compliance` and `/patches` will overlap on "stale updates"; that is
  intentional (score vs inventory). Do not delete the compliance updates check.

## Open questions

- **Install permission:** reuse `software:deploy` vs add `patch:write`. Reuse
  unless Owner/Admin need to deploy software but not OS patches (unlikely here).
- **Search cadence:** phase 2 — on the computer sweep vs a slower dedicated
  interval (e.g. daily) because Search is expensive.
- **Win10/11 QFE vs DISM packages:** if QFE is too thin on the fleet, phase 2
  can switch the installed list to `Get-WindowsPackage -Online` (heavier).
- **Auto-reboot after install:** phase 3 default should be **no** (`/norestart`
  / WUA AllowCrashes semantics); an explicit "reboot when done" flag later.
- **Winget bootstrap vs GPO:** some fleets block Store / App Installer. Fail
  soft (AC-9) rather than fighting policy; `collect_app_upgrades: false` turns
  the whole app path off.

## Related

- [28](../28-rmm-roadmap/index.md) roadmap · [21](../21-compliance/index.md)
  update age · [12](../12-scheduled-manual-scans/index.md) scan ·
  [23](../23-software-deployment/index.md) deploy · [15](../15-software-inventory/index.md)
  programs · [30](../30-alert-rules/index.md) later reboot rule
