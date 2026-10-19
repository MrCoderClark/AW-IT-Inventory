# 31. Patch management — rationale

## Why inventory first, not Search + install in v1?

The roadmap line is "detect missing → approve → deploy." Missing-detect is a
Windows Update **Search** against WSUS or Windows Update. We already isolated
WUA *history* in a 10s job because a wedged Update service blocked the whole
computer collect. Search is slower and more failure-prone than history. Install
then has to survive a reboot mid-job, with creds that must never sit in the
queue row.

Listing `Win32_QuickFixEngineering` + three reboot registry keys is local CIM,
fits the existing scan, and answers "what's on this box / does it need a
reboot?" the same day. That is the spec-29/30 pattern: ship the missing
capability (inventory) without betting on the hardest COM path.

## Why a new WinRM script, not stuffing PS_COLLECT?

pywinrm encodes PowerShell as `powershell -EncodedCommand` (~8 KB cap). Hardware
collect, posture, monitors, and local-admins are already split for that reason.
Hotfixes are another payload. A fourth small call after hardware success matches
posture: best-effort, never fails the machine.

## Why not a 15-minute worker loop?

Spec 29 samples CPU every 15 minutes because gauges move that fast. Patch state
does not. Riding the computer scan (hours, or on-demand) is the right cadence
and avoids another WinRM storm.

## Why winget for optional (non-Microsoft) apps — not Chocolatey, not Uninstall keys?

Spec 15 already has *installed* names and versions. "Chrome is behind" needs a
**catalog of latest**. Winget is that catalog on Win11 / recent Win10 and needs
no extra agent. Chocolatey (`choco outdated`) is cleaner over WinRM but is not
installed here. Diffing Uninstall keys against a homemade version list is a
product of its own.

**Do not shell out to `winget upgrade` and parse the table.** The CLI has no
`--output json`, captured output includes progress junk, and `winget.exe` as an
AppX is a long-standing WinRM failure ("logon session does not exist"). The
supported automation path is `Microsoft.WinGet.Client` (`Get-WinGetPackage |
Where-Object IsUpdateAvailable`).

**If winget is missing, install it (then list).** A catalog that only works on
machines that already have App Installer would silently skip half the fleet.
Check first (idempotent). If unusable: register the provisioned App Installer
for this session; if still missing, `Install-Module Microsoft.WinGet.Client`
then `Repair-WinGetPackageManager` (Microsoft's recommended WinRM repair). That
is the **only** scan-time write — not Chrome, not `--all`. Bootstrap is
time-boxed; PSGallery/CDN blocked → `winget_available = false`, retry next
scan. Turn the whole app path off with `collect_app_upgrades: false`.

**Do not run `winget upgrade --all`.** Same rule as OS install: see before you
push. `--all` as the scan's local-admin identity will miss or wrongly upgrade
per-user packages. Phase 3 installs only explicit per-id selections with
`--silent --disable-interactivity`, via a `patch_install_jobs` queue (deploy
twin) — not on Scan now.

App upgrades live on `/patches` next to OS KBs because that is how admins
triage "this PC is behind," not because Windows Update and winget are the same
API.

## Why reuse `updates_last_days` instead of replacing compliance?

That signal is the health *score* input and already pages via the compliance
rubric. The KB list is a different question ("which updates"). `/patches` can
show both. Filling `updates_pending` is phase 2 (WUA Search on a dedicated
daily job — never on the full scan).

## Why a dedicated daily Search loop, not Scan now / computer sweep?

`Search("IsInstalled=0")` talks to WSUS/Windows Update and is the same class of
hang that forced WUA *history* into a 10s job on posture. Putting it on every
hardware collect would make "Scan now" unreliable. A metrics-shaped worker pass
with a **120s** per-host cap and a **24h** default interval keeps inventory fresh
enough for patches without a WinRM storm. Manual Scan stays fast; install (phase 3)
can still trigger a fresh Search for one host later if we need it.

## Why current-state, no hotfix history?

Same as `installed_software`: the interesting question is what's on the machine
now. History of every KB add/remove is a reporting luxury; ingest stays a
delete+insert for that asset.
