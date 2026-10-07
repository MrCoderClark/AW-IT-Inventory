# 20. Remote printer install

**Date**: 2026-10-06
**Status**: Proposed

## Summary

OPUS gains the ability to **push-install a printer onto a specific managed
computer from the web UI**. An admin opens a computer's detail page, clicks
**Install printer**, picks a driver package from a vetted catalog (optionally
prefilling the printer name/IP from an existing printer asset), and confirms.
This enqueues a `printer_install_jobs` row; the always-on collector `worker`
claims it, pulls the driver bundle from the web app, connects into the target
over the **same WinRM channel it already uses to scan it**, installs the driver,
port, and printer, verifies with `Get-Printer`, and reports the result (with the
actual command output) back to the UI.

It reuses the established **pull-work / push-result** pattern (spec 12 scan
jobs, spec 18 cut-out worker): the collector reaches out to the web app and
initiates the connection into the target; the web app never connects into the
fleet, and the collector never listens. The driver catalog is a **filesystem
directory of packages + manifests** the admin drops into the app folder — no
upload UI in v1.

## Requirements

**User stories**:
- As an IT admin, I want to install a printer on a specific computer from OPUS,
  so I don't have to remote in and run PowerShell by hand.
- As an IT admin, I want to pick from a catalog of vetted driver packages, so
  every install uses the same, known-good driver.
- As an IT admin, I want to prefill the printer's name/IP from an existing
  printer asset, so I don't retype data OPUS already has.
- As an IT admin, I want to see whether an install actually succeeded — with the
  real command output — so I can trust it or debug a failure.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: An admin holding `printer:install` can start an install from a
  Computer's detail page: choose a driver package, optionally prefill the
  name/connection from an existing printer asset, confirm the printer name and
  connection. This creates a `printer_install_jobs` row with status `pending`.
- **AC-2**: The target must be a managed **Computer** asset with a resolvable IP
  (`computer_details.ipAddress`). Without one, the UI disables the control and
  the server action refuses (422). (WinRM reachability is checked by the worker
  at run time, not at enqueue.)
- **AC-3**: The worker claims exactly one pending install job at a time
  atomically (`FOR UPDATE SKIP LOCKED`), fenced by `workerId` + `claimedAt` like
  scan jobs; a job left in `claimed`/`running` past a timeout is reaped back to
  `pending` so a crashed worker never strands it.
- **AC-4**: The worker pulls the package's driver bundle from the web app
  (authenticated), transfers it to the target, runs the install (driver → port →
  printer), and reports `succeeded` or `failed` with captured per-step exit
  codes and stdout/stderr.
- **AC-5**: Idempotent. If the printer already exists on the target, the job
  succeeds with outcome `already-present` (no duplicate). The driver is added
  only when missing (`pnputil /add-driver` is safe to repeat).
- **AC-6**: After install the worker **verifies** via `Get-Printer` that the
  printer exists with the expected driver and port, and records it. A failed
  verify fails the job even when the install commands returned exit 0.
- **AC-7**: The computer detail page shows **install history** (package, printer
  name, status, when, requested by) and the latest status; a `pending` job shows
  a "waiting for collector" state when no worker has polled within the heartbeat
  window (reusing the spec-12 `scan_workers` heartbeat).
- **AC-8**: Driver packages are a **catalog derived from a manifest** in a
  configured drivers directory. The web reads the manifests (no secrets) to list
  each package. Dropping a new package folder + `package.json` makes it available
  (no DB migration, no redeploy — like the discovery-toggle "absent = default"
  filesystem-as-source pattern).
- **AC-9**: Starting or cancelling an install is gated on the new
  `printer:install` permission (seeded to `Owner`/`Admin`). The worker
  claim / bundle-download / status endpoints require a service token carrying
  `scan:dequeue` (reused). A user without `printer:install` sees no install
  controls and is refused by the server action.
- **AC-10**: Nothing installs that isn't in the catalog. The server action
  validates the chosen `packageId` against the catalog; the worker re-validates
  it and builds the bundle **only** from `<drivers_dir>/<id>/`. `id` is a slug
  (`^[a-z0-9][a-z0-9-]*$`) so there is no path traversal.
- **AC-11**: The bundle is **integrity-checked** (SHA-256, frozen in the job's
  package snapshot at enqueue) before any command runs on the target; a mismatch
  fails the job. The install runs from a per-job temp dir on the target and is
  cleaned up afterwards.

## Decision

**Chosen option**: Option A — extend the existing collector `worker` with a new
install job type, a web driver-bundle endpoint, and a catalog read from a
filesystem manifest. The target is reached over **WinRM** for commands and the
**SMB admin share (`C$`)** for the bundle transfer, with a base64-over-WinRM
fallback when SMB (445) is closed. A new `printer:install` RBAC permission gates
the trigger.

This keeps the outbound-only posture (collector pulls the job + bundle from web,
then initiates the connection into the target — exactly as it does to scan it),
reuses the atomic-claim / fenced-status machinery proven in spec 12, and keeps
drivers as files the admin manages on disk (as requested) rather than a new
upload/storage surface. See [rationale.md](rationale.md) for the options weighed
(a per-endpoint agent, GPO/point-and-print, and the transfer-mechanism choice).

## Feature design

### Driver catalog (filesystem + manifest)

A configured directory (default `web/drivers/`, gitignored for the bundles; an
example package is committed). Each package is a subfolder whose name is its
slug `id`:

```
drivers/
  canon-ir1750-v21/
    package.json          # manifest (committed-style, no secrets)
    driver/               # extracted driver files, including the INF
      CNLB0MA64.INF
      ...
```

`package.json` manifest fields:
- `id` — slug, must equal the folder name (validated `^[a-z0-9][a-z0-9-]*$`).
- `name`, `vendor`, `model` — display metadata for the picker.
- `driverName` — **the exact Windows driver model name published by the INF**
  (what `Add-PrinterDriver`/`Add-Printer -DriverName` expects). This is the
  single most error-prone field; a mismatch is the most common install failure,
  so it is surfaced verbatim in captured output.
- `infPath` — path to the INF relative to the package folder (e.g.
  `driver/CNLB0MA64.INF`).
- `arch` — `x64` (v1; `x86` is follow-up).
- `connection` — default connection: `{ "type": "tcpip", "port": 9100 }`,
  `{ "type": "wsd" }`, or `{ "type": "share", "path": "\\\\server\\queue" }`.
  `host` is usually left blank in the manifest and supplied at enqueue (from a
  printer asset or typed).
- `defaultPrinterName` — optional suggested printer name.

The web builds the catalog by reading the manifests at request time (the set is
small); there is **no persisted mutable `printer_packages` table**. The job row
freezes a **snapshot** of the chosen package (`driverName`, `infPath`, `arch`,
bundle `sha256`) at enqueue so a later manifest edit never changes a queued job.
`getPrinterPackages()` (web, `server-only`) reads + validates the manifests and
is the single source for both the picker and the enqueue-time validation.

### Data model (web DB `aw_it_inventory`, Drizzle; one new table)

`printer_install_jobs`
- `id` uuid pk
- `assetId` uuid not null references `assets.id` on delete cascade (the target
  computer asset)
- `targetIp` text not null (snapshot of `computer_details.ipAddress` at enqueue)
- `packageId` text not null (the catalog slug)
- `packageSnapshot` jsonb not null (`{ driverName, infPath, arch, sha256 }`,
  frozen at enqueue)
- `printerName` text not null (the name to create on the target)
- `connection` jsonb not null (resolved `{ type, host?, port?, sharePath? }`)
- `sourcePrinterAssetId` uuid null references `assets.id` on delete set null
  (set when prefilled from a printer asset; informational)
- `status` text not null default `pending`: `pending` | `claimed` | `running` |
  `succeeded` | `failed` | `canceled`
- `requestedBy` text not null (admin email from the access token; no FK — users
  live in aw-auth, same as `scan_jobs.requestedBy`)
- `workerId` text null; `claimedAt`, `startedAt`, `finishedAt` timestamptz null
- `result` jsonb null (fixed shape:
  `{ outcome: 'installed'|'already-present'|'verify-failed',
     steps: [{ name, exitCode, stdout, stderr }],
     verifiedPrinter?: { name, driverName, portName } }`)
- `error` text null (worker-level error when `status = failed`)
- `requestedAt` timestamptz not null default now; `createdAt`, `updatedAt`
- partial index on (`status`, `requestedAt`) `WHERE status = 'pending'` (cheap
  claim poll, like `scan_jobs`)

aw-auth DB: no new tables. `seed_rbac.py` gains the `printer:install` permission
and grants it to `Owner` and `Admin`. The collector service account already
holds `scan:dequeue` (spec 12), reused here.

### State transitions

`pending` → `claimed` → `running` → `succeeded` | `failed`. Reaper:
`claimed`/`running` past the timeout → `pending`. Cancel: `pending` → `canceled`.
A status update is accepted only from the worker that currently holds the claim
(`workerId` + `claimedAt` match), else 409 — identical to the spec-12 scan-job
fence, so a reaped-then-rerun job's late result can't overwrite the newer one.

### API surface

| Endpoint / action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `installPrinter` (server action) | action | assetTag, packageId, printerName, connection override | job id | cookie + `printer:install` | 403, 422 no IP / unknown package / bad connection |
| `cancelInstallJob` (server action) | action | job id | ok | cookie + `printer:install` | 403, 409 not pending |
| `/api/scan/printer-install/claim` | POST | workerId, version | one pending job (id, assetTag, targetIp, packageId, packageSnapshot, printerName, connection, workerId, claimedAt) or 204 | service `scan:dequeue` | 401, 403 |
| `/api/scan/printer-packages/{id}/bundle` | GET | package id (slug) | the driver bundle (zip stream) + `x-bundle-sha256` | service `scan:dequeue` | 403, 404, 400 bad slug |
| `/api/scan/printer-install/{id}/status` | POST | workerId, claimedAt, status, result?, error? | ok | service `scan:dequeue` | 403, 404, 409 stale claim |

The driver catalog for the UI and the install history both read straight from
the drivers dir / DB in server components (gated `printer:install` for the
catalog, `asset:read` for history) — no extra read endpoints, like spec 12's
jobs view.

### Collector flow (new module `install_printer.py` + a worker drain hook)

Folded into the existing worker loop like the cut-out drain: when no scan job is
queued, poll `/api/scan/printer-install/claim`. On a claimed job:
1. Mark `running` under the claim fence; stop if already lost (409).
2. Resolve target creds with the existing `resolve_profiles(targetIp, config)`
   (same ordered per-subnet profiles used for scanning).
3. Download the bundle from `/api/scan/printer-packages/{id}/bundle`; verify its
   SHA-256 against `packageSnapshot.sha256` **before** touching the target.
4. Transfer to the target: SMB copy to
   `\\<targetIp>\C$\Windows\Temp\opus-print\<jobId>\` using the resolved admin
   creds; **fallback**: base64-chunk the zip over WinRM `run_ps` when 445 is
   closed. Expand on the target.
5. Over WinRM run an idempotent install script, capturing each step's exit code
   and output:
   - `pnputil /add-driver <inf> /install`
   - `Add-PrinterDriver -Name "<driverName>"` (if absent)
   - tcpip: `Add-PrinterPort -Name "IP_<host>" -PrinterHostAddress <host>
     [-PortNumber <port>]` (if absent)
   - `Add-Printer -Name "<printerName>" -DriverName "<driverName>"
     -PortName "<port>"` — skipped (→ `already-present`) if `Get-Printer` already
     has it; `share`: `Add-Printer -ConnectionName "<sharePath>"`.
6. Verify with `Get-Printer -Name "<printerName>"` (driver + port) → record.
7. Clean up the per-job temp dir. Post `succeeded` with the result, or `failed`
   with the error and the captured steps.

### Key invariants

- **Catalog-only**: `installPrinter` and the worker both validate `packageId`
  against `getPrinterPackages()`; the worker reads bundle bytes only from
  `<drivers_dir>/<id>/`, `id` slug-validated — no arbitrary paths, no traversal.
- **Integrity**: `packageSnapshot.sha256` (frozen at enqueue) must match the
  downloaded bundle before any remote command runs (AC-11).
- **Atomic claim + fenced status**, identical to spec 12 (no job runs twice; a
  stale worker's update gets 409).
- **Idempotent**: `Get-Printer` precheck before `Add-Printer`; `pnputil
  /add-driver` is safe to repeat (AC-5).
- `targetIp` is frozen at enqueue; if the computer's IP later changes, the job
  used the snapshot — the admin re-enqueues to retarget.
- **Secrets never in the DB or a job**: fleet admin creds live only in
  `collector/.env` (reused); the job carries no credentials.

### Security

- **`printer:install`** is a new aw-auth permission (seeded to `Owner`/`Admin`),
  riding the access-token `perms` claim like `columns:write`/`scan:write`
  (so a newly granted role takes effect on the user's next sign-in). The UI
  hides the control without it; the server action rechecks it.
- Worker endpoints verify a `scan:dequeue` service token via the existing JWKS
  path (same as every `/api/scan/*` route). Least-privilege alternative noted in
  Follow-up: a dedicated `printer:install` service scope.
- **Remote code execution is acknowledged and bounded.** This runs installer
  code on an endpoint, so it is deliberately a separate, higher permission than
  read-only scanning. It does **not** widen the trust boundary — the collector
  already holds admin WinRM into these hosts to scan them; this uses that same
  channel for a write action. Mitigations: catalog-only vetted packages,
  slug-validated paths, SHA-256 bundle integrity, a per-job temp dir with
  cleanup, and full command output captured on the job for audit.
- The WinRM/UAC caveats from the collector AGENTS apply to installs too: a local
  admin on a domain-joined machine needs `LocalAccountTokenFilterPolicy=1`
  (push by GPO) or a domain account in local Administrators, or WinRM returns
  "Access is denied".

### Configuration required

- **web**: `PRINTER_DRIVERS_DIR` (default `./drivers` under `web/`). The dir and
  an example package are documented; real bundles are gitignored.
- **aw-auth**: add `printer:install` to `seed_rbac.py` and grant it to
  `Owner`/`Admin`, then `manage.py seed_rbac`. (The collector service account
  already has `scan:dequeue`.)
- **collector**: `printer_install_poll_interval` (default 60s, like cut-outs),
  `install_temp_dir` on the target (default `C:\Windows\Temp\opus-print`),
  `smb_transfer` on/off (default on; off forces the base64-over-WinRM path), and
  the stuck-install reaper timeout. Existing web base URL and service creds are
  reused.

### Critical test scenarios (each maps to an AC)

- **Happy path** (AC-1, AC-4, AC-6): enqueue an install, the worker claims,
  installs, `Get-Printer` confirms, the job shows `succeeded` with per-step
  output. Collector test mocks the WinRM session + SMB copy.
- **Idempotent** (AC-5): the printer already exists → `already-present`, no
  duplicate; `Add-PrinterDriver` skipped when present.
- **Catalog / traversal** (AC-10): `packageId` not in the catalog, or not a slug
  (`../x`) → server action 422 and the worker refuses.
- **Integrity** (AC-11): the downloaded bundle's SHA-256 ≠ the snapshot → job
  `failed` before any remote command.
- **No IP** (AC-2): a computer without `computer_details.ipAddress` → control
  disabled, server action 422.
- **Auth** (AC-9): no `printer:install` → no control and the action refuses; a
  service token without `scan:dequeue` → 401/403 at the worker endpoints.
- **Resilience** (AC-3): two workers poll → exactly one claims; a crash
  mid-install → the reaper returns it to `pending`; a stale status update → 409.
- **Verify failure** (AC-6): install commands return 0 but `Get-Printer` fails
  → job `failed` with outcome `verify-failed`.

## Build plan

Tracer-bullet slices (a thin thread through every layer first, then thicken),
matching spec 12's approach.

1. **Foundations.** Add `printer_install_jobs` (with the partial pending index)
   to `web/src/db/schema.ts` and `db:push`. Add `printer:install` to
   `seed_rbac.py`, grant it to `Owner`/`Admin`, reseed. Create the drivers dir +
   manifest schema + one example package, and `getPrinterPackages()` (read +
   validate + slug-guard). Satisfies **AC-8**, **AC-9**, **AC-10** (foundation).
2. **Enqueue thread.** `installPrinter` / `cancelInstallJob` server actions
   (gated on `printer:install`, re-validate the package and resolve the target
   IP), the **Install printer** dialog on the computer detail page (package
   select, "prefill from printer asset" picker, printer name + connection
   fields), and `POST /api/scan/printer-install/claim`. Satisfies **AC-1**,
   **AC-2**.
3. **Worker install path, end to end for one computer.** New
   `collector/install_printer.py` (download bundle, verify SHA-256, SMB/base64
   transfer, run the idempotent PS install, verify with `Get-Printer`, clean
   up), wired into the worker drain loop; the bundle-download endpoint; the
   status endpoint. Satisfies **AC-4**, **AC-5**, **AC-6**, **AC-11**.
4. **History + resilience.** Install-history panel on the computer detail page,
   "waiting for collector" via the existing heartbeat, the install reaper, and
   cancel. Satisfies **AC-3**, **AC-7**.
5. **Hardening + tests.** Slug validation, temp cleanup, captured output
   surfaced in the UI; collector tests (mocked WinRM/SMB) and web tests (action
   gate, package validation, claim/status fence).

## Consequences

**Positive**:
- One-click, audited printer installs from the inventory, targeted at a known
  computer — no manual remoting, no per-machine PowerShell.
- Reuses the outbound worker, the atomic-claim/fenced-status machinery, and the
  **existing WinRM credentials and channel** used for scanning; no new trust
  boundary and no inbound exposure.
- A vetted filesystem catalog keeps drivers consistent and keeps driver files as
  files the admin manages (as requested), with no new storage/upload surface.
- Every install records the real command output and a `Get-Printer` verification,
  so success is provable and failures are debuggable.

**Negative / tradeoffs**:
- Remote code execution is now a first-class, web-triggered action. Mitigated by
  the dedicated `printer:install` permission, catalog-only packages, slug-guarded
  paths, and SHA-256 integrity — but it is a real increase in what the UI can
  cause to happen on an endpoint.
- The SMB admin-share transfer adds a collector→target 445 dependency; the
  base64-over-WinRM fallback works everywhere but is slow for large bundles.
- The manifest's `driverName` must exactly match the INF's published model name;
  a mismatch is the most common failure (surfaced via captured output, not
  silently swallowed).
- The drivers directory must be populated and kept current by hand (no upload UI
  in v1).

**Neutral**:
- A new collector module and poll cadence, new env/config knobs, and a drivers
  dir to document — all additive to the existing worker.

## Follow-up

- [ ] **Batch install** — select several computers (or a whole location) and
  install to all in one action; the per-target job model already snapshots IP +
  package, so v2 enqueues N jobs or one multi-target job.
- [ ] **Uninstall / set-default / test page** — `Remove-Printer`,
  `Set-DefaultPrinter`, and printing a Windows test page as follow-on actions.
- [ ] **Driver package management UI** — upload + register packages (with
  signing/verification) instead of dropping files on disk.
- [ ] **x86 targets and driver-version tracking** — per-arch packages and
  recording installed printer/driver state back into the inventory.
- [ ] **Dedicated `printer:install` service scope** for the worker endpoints
  (instead of reusing `scan:dequeue`) if least-privilege separation is wanted.
- [ ] **WSD / IPP and point-and-print** shared-queue installs beyond the
  `tcpip`/`share` connection types.

## Rationale

Reasoning, the options weighed, and the full context: see
[rationale.md](rationale.md).
