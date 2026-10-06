# 20. Remote printer install — rationale

Context, the options weighed, and why the [index.md](index.md) decision was
made. The spec is the contract; this is the reasoning behind it.

## Context

OPUS already inventories computers and printers, scans the Windows fleet over
WinRM, and runs a long-lived collector `worker` that drains a job queue
(spec 12) and background-removal jobs (spec 18). Installing a printer on a
machine is, mechanically, the same thing the collector does every day to read
hardware — it opens a WinRM/PowerShell session to the host with a local-admin
profile — except it runs `Add-Printer` instead of `Get-CimInstance`. The admin
already has the driver files and wants to place them "in a location within the
app folder structure" and trigger installs from the UI.

So the question is not *can we* (the channel, creds, and job machinery all
exist) but *how to shape it* so it fits the project's two hard constraints:

1. **Outbound-only coordination.** The web app never connects into the fleet;
   the collector never listens. All web↔collector traffic is the collector
   pulling work and pushing results. (The collector *does* initiate connections
   into the fleet — that's how it scans — so target-side actions are fine as long
   as the collector initiates them.)
2. **Agentless.** No persistent software installed on endpoints.

## Options weighed

### A. Extend the worker with an install job type (chosen)

Add a `printer_install_jobs` queue, a driver-bundle endpoint, and a new
collector module that claims a job, pulls the bundle, and installs over
WinRM/SMB. Mirrors spec 12 (claim/fence/reaper) and spec 18 (worker pulls bytes
from web, does work, posts result).

- **For**: reuses everything — the outbound posture, the atomic-claim and
  fenced-status code, the existing per-subnet admin credentials and WinRM
  channel, and the worker process the admin already runs. No new trust boundary:
  the collector can already run arbitrary PowerShell on these hosts to scan them.
- **Against**: makes the UI able to trigger remote code execution; the trigger
  must be gated harder than scanning. Addressed with a dedicated
  `printer:install` permission, catalog-only packages, and bundle integrity.

### B. A per-endpoint agent that installs

Install a small OPUS agent on each computer that receives install commands.

- **For**: could pull directly and self-install; no transfer problem.
- **Against**: breaks the **agentless** principle outright, adds a deployment and
  update surface across 100+ machines, and a listening agent is an inbound
  attack surface. Rejected.

### C. Defer to GPO / Intune / a print server (point-and-print)

Don't build install into OPUS; manage printers through AD/Intune, or add a
shared print queue and let users point-and-print.

- **For**: these are the "normal" enterprise mechanisms and the shop may already
  use some of them.
- **Against**: they are *policy-wide* and tied to AD/Intune plumbing; they don't
  give the **targeted, on-demand, audited "install this printer on that one
  machine now"** action the admin is asking for, and the workgroup subnet
  (`192.168.72.0/24`) isn't domain-managed at all. Rejected as the primary
  mechanism — but **point-and-print is kept as a supported connection type**
  (`connection.type = "share"`), so OPUS can drive a shared-queue install where
  that's the right answer.

## Transfer mechanism (how the driver bytes reach the target)

The driver bundle lives on the web app (in the drivers dir). The collector must
get it onto the target. Three ways:

1. **SMB admin share (`\\target\C$`) — chosen primary.** The collector copies the
   bundle to a temp dir on the target using the same admin creds it authenticates
   WinRM with, then runs `pnputil`/`Add-Printer` over WinRM. Fast, simple, and
   collector→target SMB is already a trusted path on these networks.
2. **base64-over-WinRM — chosen fallback.** Chunk the zip through `run_ps` writes
   when 445 is closed. Works anywhere WinRM does, but slow for large bundles — so
   it's the fallback, not the default (`smb_transfer: false` forces it).
3. **Target pulls from the web app.** Rejected: it would require every fleet
   machine to reach the app over HTTP and couples the endpoint to the web tier,
   cutting against the outbound-only/agentless posture (the fleet shouldn't need
   routes or creds to the app; only the collector does).

## Driver catalog: filesystem manifest vs. DB-managed upload

The admin explicitly wants drivers "in a location within the app folder." So v1
reads a **filesystem directory of packages + `package.json` manifests** (the same
"filesystem/absent = source of truth" idea as the discovery toggles), with
**no persisted mutable catalog table** — the only DB row is the install job,
which freezes a *snapshot* of the chosen package so a later manifest edit can't
mutate a queued job. An **upload/registration UI** (with signing/verification) is
recorded as follow-up, not v1, to avoid building a storage/validation surface
before it's needed.

The riskiest manifest field is `driverName`: it must be the **exact** model name
the INF publishes (what `Add-Printer -DriverName` matches). We don't try to parse
it out of the INF automatically in v1 (INF parsing is fiddly and vendor-specific)
— the admin sets it, and a mismatch surfaces as captured `Add-Printer` output on
the failed job rather than a silent no-op. Auto-deriving `driverName` from the INF
is a reasonable later enhancement.

## Permission: new `printer:install` vs. reuse `scan:write`

Scanning is read-only; installing runs installer code on a machine. Conflating
them would mean anyone who can refresh inventory can also push software to
endpoints. A dedicated `printer:install` permission (one `seed_rbac` line,
granted to `Owner`/`Admin`) keeps least-privilege and makes the capability
explicit and grantable on its own. The cost — a reseed and the usual "re-login to
pick up a new perm" caveat — is trivial. The worker's claim/report endpoints
reuse the existing `scan:dequeue` service scope (same collector identity, same
pull-work pattern); a dedicated service scope is noted as follow-up if tighter
separation is wanted.

## Scope: single-computer v1

v1 installs to **one computer at a time** from its detail page, with status and
history. The job model is already per-target and snapshots IP + package, so
**batch** (several computers or a location) and **uninstall / set-default / test
page** are natural follow-ons that don't require reworking the foundation — they
were deferred to keep the first version small and the remote-execution surface
easy to reason about.

## What this intentionally does not do (v1)

- No x86 target support (x64 only) — per-arch packages are follow-up.
- No driver-version tracking back into the inventory.
- No uninstall/removal or set-default from the UI.
- No batch/multi-target install.
- No upload UI for driver packages (filesystem only).
- No automatic `driverName` extraction from the INF.
