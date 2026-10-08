# 21. Compliance & device health

**Date**: 2026-10-08
**Status**: Proposed

## Summary

OPUS collects rich **inventory** today (hardware, OS, software, uptime) and shows
it on the computer detail page. It collects nothing about a device's **security
posture**, and `/compliance` is a placeholder. This spec adds a posture collect
over the existing WinRM path, a per-device **health score (0–100)** with
🟢/🟡/🔴/⚪ component checks, and a fleet-wide `/compliance` dashboard that answers
"how healthy is the fleet, and which machines need attention — or can't even be
assessed."

Scope is deliberately split from inventory: `/compliance` does **not** re-list
hostname/CPU/RAM/serial/software (those stay on the computer detail page and the
Computers table). It is about the new posture signals and the score derived from
them.

**v1 signal set (this spec):** BitLocker · Defender/AV · TPM · Secure Boot ·
Windows Update currency · disk-full %. (Local administrators, network-adapter
enumeration, and all-logged-on-sessions are a documented follow-up, not v1.)

## Requirements

**User stories**:
- As an IT admin, I want each managed computer scored on its security posture so I
  can triage the fleet at a glance instead of RDP-ing into machines.
- As an IT admin, I want the per-device breakdown (what's green/yellow/red and why)
  so a low score is actionable.
- As an IT admin, I want a fleet view — how many machines are encrypted, AV-healthy,
  behind on updates — and to filter to the non-compliant ones.
- As an IT admin, I want machines we **can't assess** (no remote admin token) to be
  visibly flagged, not silently counted as healthy.

**Acceptance criteria** (each independently checkable):
- **AC-1**: The WinRM collect gathers the v1 posture signals in the **same
  PowerShell round-trip** as the hardware/health/software collect (one call, not a
  new scan path). A posture read failure is **best-effort**: it never fails the
  machine collect — an unreadable signal is recorded as `unknown`, not an error.
- **AC-2**: Posture is stored per Computer asset as **current state, no history**,
  keyed by `assetId` (mirrors `installed_software` / `printer_counters`). It is
  upserted at ingest in a best-effort step that never fails the machine ingest.
  `null`/absent posture (non-Windows, or the collector didn't read it) leaves the
  prior row intact; it does not blank it.
- **AC-3**: The health score (0–100) is **computed at read time** from the stored
  posture by one pure, shared function (server + testable), using the default
  rubric below. It is not persisted, so the rubric can change with no migration.
- **AC-4**: Each component check resolves to **🟢 pass / 🟡 warn / 🔴 fail / ⚪
  unknown**. An `unknown` check earns **0** points toward the 100-point total
  (fail-closed), but is rendered distinctly (⚪, not 🔴) and the device is badged
  "limited visibility — N signals unreadable" so a low score from unreadability is
  not mistaken for known-bad.
- **AC-5**: A device whose **every** v1 signal is `unknown` shows **"Not assessed"**
  (no numeric score) with a prompt to enable remote admin
  (`LocalAccountTokenFilterPolicy` / GPO), rather than `0/100`.
- **AC-6**: The computer detail page gains a **Compliance** tab: the score, the
  component rows with their status + value + the rule that set them, and the
  last-assessed time. Gated like the rest of the detail page (`asset:read`).
- **AC-7**: `/compliance` shows a fleet dashboard: summary tiles (% BitLocker on,
  % AV healthy, # >30 days behind on updates, # not assessed), and a sortable table
  of computers by score with per-check status chips, plus a **"non-compliant only"**
  filter. `asset:read`-gated (viewing open like `/software` and `/reports`).
- **AC-8**: Posture signals that require an elevated/full token (BitLocker, TPM) are
  read best-effort; on a UAC-token-filtered machine they come back `unknown` and the
  device surfaces per AC-4/AC-5 — i.e. the feature **diagnoses** the very token
  problem it depends on, rather than failing opaquely.

## Signals collected (v1) — how and what we store

All read in the existing `collect_windows` PowerShell call, each wrapped so a
failure yields `unknown` for that signal only (never aborts the collect):

| Signal | Source (PowerShell) | Stored |
|---|---|---|
| **BitLocker** | `Get-BitLockerVolume` (system drive) | `on` / `off` / `unknown` (+ protection status) |
| **Defender/AV** | `Get-MpComputerStatus`; fall back to `root/SecurityCenter2` `AntiVirusProduct` for 3rd-party | realtime on/off, signature age (days), product name |
| **TPM** | `Get-Tpm` | present & ready `yes`/`no`/`unknown` |
| **Secure Boot** | `Confirm-SecureBootUEFI` | `on`/`off`/`unknown` (legacy BIOS → not-applicable) |
| **Windows Update** | `Microsoft.Update.Session` COM (last-installed date, pending count) | days since last update, pending count |
| **Disk free** | already collected (`free_disk_gb` + disk size) | % full of the system drive |

Stored as a `compliance_status` row per `assetId`: the raw values above + an
`assessedAt` timestamp. The score and the 🟢🟡🔴 verdicts are **derived**, not stored.

## Default health-score rubric (AC-3)

100-point total; each check earns its weight for 🟢, roughly half for 🟡, 0 for 🔴
or ⚪:

| Check | Weight | 🟢 pass | 🟡 warn | 🔴 fail |
|---|---:|---|---|---|
| BitLocker (system drive) | 25 | encrypted & protected | — | off/suspended |
| Defender/AV | 25 | realtime on, signatures ≤7d | signatures 8–30d | off / signatures >30d |
| Windows Update | 20 | ≤14 days since last | 15–30 days | >30 days |
| TPM | 10 | present & ready | — | absent/not ready |
| Secure Boot | 10 | enabled | — | disabled |
| Disk free (system drive) | 10 | <85% full | 85–95% | >95% full |

`score = round(sum of earned points)` over the full 100-point denominator; `unknown`
earns 0 (AC-4). This is a **starting default** — weights/thresholds live in one
constants block and are expected to be tuned after seeing real fleet numbers.

## Data model

New `compliance_status` table (inventory DB), 1:1 with a Computer asset:
`assetId` (FK, PK or unique), the raw signal columns above, `assessedAt`. No
history table in v1 (like `installed_software`). **Needs `npm run db:push`.**

## UI

- **Computer detail → Compliance tab** (`asset:read`): big score, component rows
  (status chip · value · the rule), last-assessed, and the "limited visibility" /
  "not assessed" states.
- **`/compliance`** (`asset:read`): `HeroHeader` + summary stat tiles + a sortable
  computers-by-score table with per-check chips and a non-compliant filter. Reuses
  the dataviz/stat-tile patterns from `/reports` and the dashboard.

## Phases

1. **Collector + storage** — posture signals in `collect_windows`, `compliance_status`
   table + ingest upsert, the score function + tests. (No UI yet; verify via DB/ingest.)
2. **Per-device Compliance tab** — the detail-page tab + score/breakdown rendering.
3. **`/compliance` dashboard** — fleet tiles, table, filters.

## Out of scope (follow-ups)

- Local administrators, full network-adapter enumeration, all logged-on sessions.
- Posture **history**/trend (v1 is current-state only).
- Remediation actions from the UI (enable BitLocker, force update) — read-only for now.
- Alerting/notifications on a failing check (could later hook spec 19).

## Gotchas / dependencies

- **BitLocker and TPM need the full admin token.** On a UAC-token-filtered machine
  (local account on a domain-joined box without `LocalAccountTokenFilterPolicy=1`)
  they return `unknown`. This is the same dependency the collector onboarding runbook
  covers (`docs/runbooks/onboard-computer.md`), and AC-5 turns it into a visible,
  actionable state rather than a silent gap.
- **3rd-party AV** reports through `root/SecurityCenter2`; Defender's own
  `Get-MpComputerStatus` is absent/disabled when a 3rd-party product is primary, so
  read both and prefer whichever reports healthy/primary.
- Windows Update via the COM API can be slow; keep it best-effort and time-bounded so
  it never stalls the collect.

## Related

- [04](../04-collector-agent-spec.md) collector · [15](../15-software-inventory/index.md)
  software inventory (the per-asset current-state pattern this reuses) ·
  [19](../19-notifications/index.md) notifications (future alerting hook) ·
  `docs/runbooks/onboard-computer.md` (the admin-token dependency).
