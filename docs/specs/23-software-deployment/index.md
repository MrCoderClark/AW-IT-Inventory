# 23. Software Deployment — push an uploaded installer to a computer

**Date**: 2026-10-12
**Status**: Proposed

## Summary

OPUS gains **Software Deployment**: an admin builds a **package** in a **Software
Library** and deploys it to any managed **Computer** from that computer's detail
page. A package is an **ordered list of steps** — inline **PowerShell** steps and
**MSI/EXE installer** steps — that the collector runs **in order, stopping on the
first failure**. (A plain single installer is just a one-step package.) The
always-on collector `worker` claims the deploy job, pulls each installer, transfers
it into the target over the **same WinRM channel it already uses to scan and to
install printers**, verifies each file's hash, runs each step **silently /
elevated**, captures per-step exit codes + output, and reports the result back.
Every deployment is recorded per computer (who, when, outcome).

> **Why steps.** Real installs are often multi-part — e.g. an ePad signature pad
> needs .NET 3.5 enabled, then two EXE installers in order. A package models that
> as ordered steps rather than a single file, so one deploy does the whole job.

It keeps the **outbound-only** posture of every other collector feature (spec 12
scan jobs, spec 18 cut-out, spec 20 printer install, spec 24 remote actions): the
web app never connects into the fleet — the **collector dials out** for the job
and the installer bytes, and initiates the connection into the target. It reuses
the **atomic-claim / fenced-status / reaper** queue machinery and the **SMB /
base64-over-WinRM** file transfer already built for printer install (spec 20).

> **Honest scope note (read first).** **MSI is standardized** — `msiexec /qn`
> installs any MSI silently, with well-known exit codes (`0` ok, `3010`
> success-reboot-required). **EXE installers are not**: there is no universal
> silent switch — InnoSetup wants `/VERYSILENT`, NSIS `/S`, InstallShield
> `/s /v"/qn"`, etc., and each defines its own exit codes. So an EXE package
> **requires the admin to supply the correct silent arguments** when uploading it;
> OPUS runs exactly those. This spec deploys per-machine, on demand; **multi-target
> fleet rollout, scheduling, and uninstall are Follow-ups.**

## Requirements

**User stories**:
- As an IT admin, I want to upload an installer once and keep a library of
  approved software, so I deploy vetted packages, not ad-hoc files.
- As an IT admin, I want to push a chosen package to a specific computer from its
  page, so I don't have to remote in and run installers by hand.
- As an IT admin, I want the install to run **silently** and tell me whether it
  succeeded (exit code, output), so I know the outcome without watching it.
- As a security owner, I want deployments gated and audited — who deployed what,
  where, when, and the result — and the installer's integrity verified before it
  runs on an endpoint.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: An admin holding `software:deploy` can **upload** an installer
  (MSI/EXE) with a name, version, type, and (for EXE) silent arguments. The bytes
  are stored in the private object store under a random key; a `software_packages`
  catalog row records the metadata, size, and **SHA-256** of the uploaded bytes.
  An upload over the size cap or of a disallowed type is refused (413/415).
- **AC-2**: From a **Computer's** detail page (a managed Computer asset with a
  resolvable `computer_details.ipAddress`), that admin can **deploy** a library
  package to it. A non-Computer or an asset with no IP disables the control and the
  action refuses (422). This creates a `software_deployments` row (`pending`) with
  a **frozen snapshot** of the package (name, version, type, args, sha256) so a
  later library edit never changes a queued job.
- **AC-3**: The worker claims exactly one pending deployment at a time atomically
  (`FOR UPDATE SKIP LOCKED`), fenced by `workerId` + `claimedAt`, exactly like scan
  and printer-install jobs; a claim/run left past a timeout is reaped back to
  `pending` (retry) or `failed`, so a crashed worker never strands a job.
- **AC-4**: The worker **transfers** the installer into the target's temp dir —
  SMB admin-share (fast) with base64-over-WinRM fallback, reusing the spec-20
  staging path — **re-verifies the SHA-256 on the target**, and **aborts without
  running** on a mismatch (the deployment fails with an integrity error, AC-9).
- **AC-5**: The worker runs the installer **silently**: MSI via
  `msiexec /i <file> /qn /norestart`; EXE via the package's admin-supplied silent
  args. Success is exit `0` (and `3010` = reboot required, surfaced as
  success-with-reboot); any other code is a failure with the captured
  stdout/stderr tail. The temp file is always cleaned up.
- **AC-6**: The deployment **result** is reported back fenced by the claim: status
  `succeeded` / `failed`, the exit code, an output tail, and (best-effort) the
  **installed version detected** from the target's registry Uninstall keys. A
  finished deployment raises an in-app notification (like spec 20) and shows in the
  computer's **deployment history**.
- **AC-7**: Uploading, managing, and deploying are gated on a new
  **`software:deploy`** permission (seeded to `Owner` **and** `Admin`, like
  `printer:install`). The worker's claim/transfer/result endpoints require a
  service token carrying the **`deploy:agent`** scope. A user without
  `software:deploy` sees no Software Library or Deploy controls, and every action /
  cookie endpoint refuses them.
- **AC-8**: Every deployment is **audited**: the `software_deployments` row keeps
  the requester, target, frozen package snapshot, status, exit code, output tail,
  and timestamps; history is listed per computer and survives for review. Installed
  software also reflects the new program on the next scan (spec 15).
- **AC-9**: The deployment carries **no credentials**. Fleet admin creds live only
  in `collector/.env` (reused, resolved per subnet exactly as for scanning/printer
  install); the `software_deployments` row and every relay payload are
  credential-free. The installer bytes reach the collector only through an
  authenticated, service-scoped pull endpoint; the object store stays private.
- **AC-10**: **Bounded.** An upload size cap and an allow-list of installer types
  are enforced; a deployment can be **canceled** while `pending`/`claimed`/`running`
  (releases it from the queue, fenced so a late worker result no-ops); the reaper
  bounds stuck jobs; a package in use by history is **soft-guarded** on delete
  (the object is removed but the catalog row is kept/flagged, so history still
  resolves its name/version).

## Decision

**Chosen option**: A **library + queue** model that mirrors printer install
(spec 20) end to end, with object storage for the uploaded bytes:

- Installers are **uploaded through the UI** and stored in the existing private
  **S3-compatible object store** (`lib/storage.ts`, same store as media), keyed by
  a random path; a **`software_packages`** catalog table holds the metadata +
  SHA-256. (Printer drivers are a filesystem drop with no DB catalog; software
  packages are user-uploaded, so they get a catalog row + an object — see
  [rationale.md](rationale.md).)
- Deployments are a **`software_deployments`** queue reusing the scan/printer
  **atomic-claim / fenced-status / reaper** machinery (`db/scan.ts`,
  `db/printer-install.ts`).
- The collector pulls the installer over an authenticated, **`deploy:agent`**-scoped
  endpoint and transfers it into the target with the **spec-20 SMB/base64 staging**
  path, then runs it silently.
- A new **`software:deploy`** RBAC permission gates the UI/actions (Owner + Admin);
  a new **`deploy:agent`** service scope gates the worker endpoints.

This adds **no new infrastructure** and **no new trust boundary**: the collector
already holds admin WinRM into these hosts (to scan them and install printers);
deployment uses that same channel and the same transfer code. WebDAV/HTTP pull
from the target, PSExec/GPO/Intune-style delivery, and a filesystem package drop
are weighed and deferred in [rationale.md](rationale.md).

## Feature design

### Flow (all hops initiated toward the web app / target by the edges)

```
 Admin ──upload MSI/EXE──► Web app ──(S3 put)──► object store      Computer detail: pick package ─► Deploy
                             │                                              │
                             ▼                                              ▼
                    software_packages (catalog + sha256)          software_deployments (pending)
                                                                           │  ◄── claim (deploy:agent) ── Collector
                                                      installer bytes pull ─┘  ── SMB/base64 ─► Target ── msiexec/EXE /silent
                                                                           ▲                                   │
                                                                           └────────── result (fenced) ────────┘
```

### Data model (web DB `aw_it_inventory`, Drizzle; two new tables)

`software_packages` (the package catalog: a header + ordered steps)
- `id` uuid pk
- `name` text not null; `version` text not null (free-form, e.g. `2024.1`)
- `publisher` text null
- `steps` jsonb not null default `[]` — an ordered `SoftwareStep[]`, each a
  discriminated union:
  - **script**: `{ id, kind:"script", name, script, continueOnError? }` — inline
    PowerShell run elevated on the target.
  - **install**: `{ id, kind:"install", name, installerType:"msi"|"exe", fileName,
    silentArgs, sha256, storageKey, fileSize, continueOnError? }` — an uploaded
    installer (bytes in the object store under `storageKey`, re-verified by
    `sha256`). EXE requires `silentArgs`; MSI defaults to `/qn /norestart`.
  - `id` is stable per step (reorder in the UI; per-step results); `continueOnError`
    defaults false, so a non-zero exit stops the package.
- `uploadedBy` text not null (admin email; no FK — users live in aw-auth)
- `archivedAt` timestamptz null (soft-guard on delete when history references it)
- `createdAt`, `updatedAt` timestamptz not null default now
- index on `createdAt`; optional unique on (`lower(name)`, `lower(version)`)

Installer files upload one at a time (`POST /api/software/packages/files` → stores
the object, returns the step's `{ storageKey, sha256, fileSize, fileName,
installerType }`); the package is then created with the assembled step list
(`POST /api/software/packages`). Deleting a package removes every install step's
object.

`software_deployments` (the deploy queue; mirrors `printer_install_jobs`)
- `id` uuid pk
- `assetId` uuid not null → `assets.id` on delete cascade (target computer)
- `targetIp` text not null (snapshot of `computer_details.ipAddress` at enqueue)
- `packageId` uuid null → `software_packages.id` on delete set null
- `packageSnapshot` jsonb not null — `{ name, version, installerType, silentArgs,
  fileName, sha256, storageKey }` frozen at enqueue (survives a library edit/delete)
- `status` text not null default `pending`: `pending` | `claimed` | `running` |
  `succeeded` | `failed` | `canceled`
- `requestedBy` text not null (admin email)
- `workerId` text null; `claimedAt`, `startedAt`, `finishedAt` timestamptz null
- `result` jsonb null — `{ exitCode, rebootRequired, detectedVersion, outputTail,
  steps[] }`
- `error` text null (worker-level / integrity error on failure)
- `createdAt`/`requestedAt`, `updatedAt` timestamptz not null default now
- partial index on `assetId WHERE status IN ('pending','claimed','running')` (the
  "in-flight per computer" read + optional one-at-a-time guard); partial index
  `WHERE status='pending'` for the claim poll (like `scan_jobs`)

aw-auth DB: no new tables. `seed_rbac.py` gains **`software:deploy`** (granted to
`Owner` and `Admin`, like `printer:install`); the collector service account gains
the **`deploy:agent`** scope (alongside `ingest:write` / `scan:dequeue` /
`remote:agent`).

### Object storage

Uploaded installers can be large (tens–hundreds of MB), so `lib/storage.ts` gains a
**generic** object path (`putObject` / `getObjectBytes` / `removeObject`) beside the
image-typed helpers, with an installer **allow-list** (`application/x-msi`,
`application/x-msdownload`, `application/octet-stream` + extension check `.msi` /
`.exe`) and a size cap (`SOFTWARE_MAX_UPLOAD_BYTES`, default 300 MB). The bucket
stays private; bytes reach the collector only through the service-scoped pull
endpoint (streamed, not base64-in-JSON, for large files — see API).

### API surface

| Endpoint / action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/software/packages/files` | POST (multipart) | file (MSI/EXE) | step file meta (storageKey, sha256, size, type) | cookie + `software:deploy` | 403, 413 too big, 415 bad type |
| `/api/software/packages` | POST (JSON) | name, version, publisher, steps[] | package id | cookie + `software:deploy` | 403, 400 bad steps, 409 dup |
| `deleteSoftwarePackage` (action) | action | packageId | ok | cookie + `software:deploy` | 403 (soft-archives when in use) |
| `deploySoftware` (action) | action | assetTag, packageId | deployment id | cookie + `software:deploy` | 403, 404, 422 no IP / not a Computer |
| `cancelDeployment` (action) | action | deploymentId | ok | cookie + `software:deploy` | 403, 404 |
| `/api/deploy/claim` | POST | workerId | one pending deployment (id, assetTag, targetIp, packageSnapshot, workerId, claimedAt) or 204 | service `deploy:agent` | 401, 403 |
| `/api/deploy/{id}/steps/{stepId}/file` | GET | workerId, claimedAt | that install step's bytes (streamed), resolved from the claimed deployment's frozen snapshot | service `deploy:agent` | 403, 404, 409 stale |
| `/api/deploy/{id}/status` | POST | workerId, claimedAt, status, result / error | ok | service `deploy:agent` | 401, 403, 409 stale claim |

Library list + per-computer deployment history read straight from the DB in server
components gated `software:deploy` — no extra read endpoints (like spec 12/20).

### UI surfaces

- **Software Library** (new page, e.g. `/software/library` or an `/admin` card):
  upload (MSI/EXE + name/version/type/silent args), list with size/version/uploader,
  delete. Gated `software:deploy`; read-only hint for others.
- **Deploy control on the Computer detail page** — a **Software** tab/panel: pick a
  library package, **Deploy**, and a **deployment history** table (package, version,
  status, exit code, who/when), with a `waitingForCollector` state via `isWorkerLive`
  and a cancel action — mirroring the printer-install panel.

### Collector flow (new module `software_deploy.py` + a worker drain hook)

Folded into the worker loop like the printer-install / cut-out drains: when no
scan job is queued, poll `/api/deploy/claim`. On a claimed deployment:
1. Mark `running` under the claim fence (stop if lost, 409). Resolve target creds
   with `resolve_profiles(targetIp, config)` and open WinRM.
2. **Pull** the installer bytes from `/api/deploy/packages/{id}/file`.
3. **Transfer** to the target temp dir via the spec-20 `_stage` path (SMB fast /
   base64 fallback) and **verify the SHA-256 on the target**; abort → `failed`
   (integrity) on mismatch.
4. **Run each step in order**, stopping on the first non-zero exit (unless the step
   is `continueOnError`); remaining steps are recorded `skipped`:
   - **script** → run the inline PowerShell elevated, capture exit + output.
   - **install** → pull + hash-verify the file, transfer it in, then MSI →
     `msiexec /i <file> /qn /norestart [args]`; EXE → `<file> <silentArgs>`. Map `0`
     and `3010` (reboot-required) to success.
5. Clean up the temp dir (always). Post the final result — overall
   `succeeded`/`failed` plus the per-step exit codes + output tails — fenced by the
   claim.

### Key invariants

- **Outbound-only**: the collector initiates the pull, the transfer, and the run;
  the web app never connects into the fleet (AC-9).
- **Atomic claim + fenced result**, identical to spec 12/20: one worker per
  deployment; a stale worker's result post gets 409.
- **Frozen snapshot + integrity**: the package is snapshotted at enqueue and the
  bytes are SHA-256-verified on the target before running; a later library edit or
  delete never alters an in-flight job (AC-2/4).
- **Credential-free rows/payloads**: creds only in `collector/.env` (AC-9).
- **Bounded**: upload size/type caps, cancel, reaper, soft-guarded package delete
  (AC-10).

### Security

- Deploying an arbitrary MSI/EXE **is code execution as admin on the endpoint** —
  powerful, but the same class as printer install (which stages a driver and runs
  pnputil/Add-Printer). It gets a dedicated **`software:deploy`** permission
  (Owner + Admin, matching `printer:install`), gated in the UI and rechecked in
  every action / cookie endpoint.
- It does **not** widen the trust boundary: the collector already holds admin WinRM
  into these hosts. Mitigations: an **approved library** (you deploy vetted
  uploads, not arbitrary paths), **SHA-256 integrity** verified on the target
  before running, full **audit** (who/what/where/result), cancel + reaper, and a
  least-privilege **`deploy:agent`** service scope distinct from `scan:dequeue`.
- The WinRM/UAC caveats from the collector AGENTS apply: a local admin on a
  domain-joined host needs `LocalAccountTokenFilterPolicy=1` (GPO) or a domain
  account in local Administrators, else WinRM returns "Access is denied".
- The object store stays private; installer bytes are served only to a
  `deploy:agent` token, never a public URL.

### Configuration required

- **web**: `SOFTWARE_MAX_UPLOAD_BYTES` (default 300 MB); reuse `S3_*` (shared store);
  deployment stuck-timeout env (like `INSTALL_STUCK_JOB_TIMEOUT_MS`). The upload +
  installer-file routes use the Node runtime (`runtime = "nodejs"`).
- **aw-auth**: add `software:deploy` to `seed_rbac.py` (Owner + Admin), add the
  `deploy:agent` scope to the collector service account, then `manage.py seed_rbac`
  / `set_service_account_scopes`.
- **collector**: `software_deploy_poll_interval`, `software_deploy_temp_dir`
  (default `C:\Windows\Temp\opus-deploy`); reuse `install_smb_transfer` and the
  existing fleet creds / web base URL.

### Critical test scenarios (each maps to an AC)

- **Upload** (AC-1): a valid MSI/EXE is stored with its sha256 + catalog row; an
  oversize file → 413; a `.txt` → 415.
- **Deploy happy path** (AC-2/4/5/6): deploy → worker claims → transfers →
  sha256 matches → `msiexec /qn` exit 0 → `succeeded` with the detected version;
  collector test mocks WinRM, web tests cover enqueue/claim/status fence.
- **EXE silent args** (AC-5): an EXE package runs with exactly its configured args;
  a non-zero exit → `failed` with the output tail.
- **Integrity** (AC-4/9): a tampered/wrong-hash transfer aborts without running →
  `failed` (integrity error).
- **No IP / not a Computer** (AC-2): control disabled, action 422.
- **Auth** (AC-7): no `software:deploy` → no controls and every endpoint refuses; a
  service token without `deploy:agent` → 401/403 at the deploy endpoints.
- **Resilience** (AC-3/10): two workers poll → one claims; a crash mid-run → the
  reaper requeues/fails it; a stale worker's result post → 409; cancel releases a
  pending/running job and the late result no-ops.
- **Soft delete** (AC-10): deleting a package that history references removes the
  object but keeps history resolvable (snapshot + archived catalog row).

## Build plan

Tracer-bullet slices — a thin thread end to end, then thicken.

1. **Foundations.** Add `software_packages` + `software_deployments` (with indexes)
   to `schema.ts` and `db:push`. Add `software:deploy` (Owner + Admin) and the
   `deploy:agent` scope to `seed_rbac.py`; reseed / re-issue. Generic object-store
   `putObject`/`getObjectBytes`/`removeObject` + size/type guard. The `server-only`
   `db/software-packages.ts` (upload-row CRUD, soft-archive) and
   `db/software-deploy.ts` (enqueue, claim, status, cancel, reaper, history).
   Satisfies **AC-1/2/3** foundation.
2. **Library UI.** Upload route/action (multipart → S3 + sha256 + catalog row),
   Software Library page (list/upload/delete), gated `software:deploy`. Prove
   upload → store → list → delete. Satisfies **AC-1/7**.
3. **Deploy trigger + queue + panel.** `deploySoftware` / `cancelDeployment`
   actions, the computer-detail **Software** panel (pick package, deploy, history),
   the `claim` / `status` / installer-`file` endpoints. Prove enqueue → claim with a
   **stub worker**. Satisfies **AC-2/6/8** (web side).
4. **Collector worker.** `collector/software_deploy.py`: pull the installer,
   SMB/base64 transfer (reuse spec-20 staging), sha256-verify on target, run
   MSI/EXE silently, capture exit/output, registry-verify, post result. Wire into
   the worker drain. Real end-to-end. Satisfies **AC-4/5/6/9**.
5. **Bounds + hardening + tests.** Cancel, reaper, soft-guarded delete,
   notifications on finish, result-detail view, retention; collector tests (mocked
   WinRM) + web tests (upload gate, enqueue/claim/status fence, integrity abort).
   Satisfies **AC-3/9/10**.

## Consequences

**Positive**:
- Push vetted software to any managed computer from the inventory, reusing the
  outbound worker, the atomic-claim/fenced machinery, the SMB/base64 transfer, and
  the **existing WinRM credentials and channel** — no agent, no new infra.
- An **approved library** with integrity verification makes deployment auditable
  and tamper-evident; results flow into history and (on next scan) the spec-15
  software inventory.

**Negative / tradeoffs**:
- **Arbitrary installer execution as admin is now web-triggered.** Bounded by an
  Owner/Admin permission, an approved library, on-target hash verification, cancel,
  reaper, and full audit — but a real increase in what the UI can cause.
- **EXE silent install is installer-specific**: the admin must supply correct silent
  args per EXE, and EXE exit codes aren't standardized, so a "succeeded" on a quirky
  EXE can still mean "ran, outcome unverified" (the registry-version check mitigates).
- Large uploads/transfers: base64-over-WinRM is slow for big installers (SMB is the
  real path); object-store space is consumed per package.

**Neutral**:
- A new collector module + drain, two new tables, a generic object-store path, new
  env/config knobs, and a Software Library UI — all additive to the existing worker
  and UI.

## Follow-up

- [ ] **Multi-target rollout** — deploy one package to many computers (a fleet view
  / selection), with per-target status.
- [ ] **Scheduling / maintenance windows** — enqueue deployments to run later.
- [ ] **Uninstall / repair** — msiexec `/x`, and version-aware upgrade.
- [ ] **Dependency/order chains** — deploy a set in order, stop on first failure.
- [x] **Spec 23 polish (slices 1–3)** — skip-if-installed + step timeouts;
  client-side package templates in the editor; break-glass export (`.ps1` +
  signed file URLs). Shipped on branch `feat/software-deploy-polish` (awaiting merge).
  Design:
  [2026-10-27-software-deploy-polish-design.md](../../superpowers/specs/2026-10-27-software-deploy-polish-design.md).
- [ ] **Broader detection rules** — e.g. skip when product **absent**, beyond slice-1
  `product_installed` and the post-install registry check.
- [ ] **Deep spec-15 integration** — auto-add a deployed title to the tracked
  watchlist; show "deployed by OPUS" provenance on the software inventory.
- [ ] **Signature/publisher verification** — check the installer's Authenticode
  signature at upload and/or on the target before running.

## Rationale

The options weighed (upload+library vs filesystem drop, object store vs DB blob,
transfer mechanism, permission/scope model, MSI vs EXE handling), and the full
context: see [rationale.md](rationale.md).
