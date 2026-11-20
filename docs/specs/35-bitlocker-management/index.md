# 35. BitLocker Management — enable, escrow, and view recovery keys

**Date**: 2026-11-20
**Status**: Proposed

## Summary

H2Tecs gains **BitLocker Management**: an admin can enable BitLocker on any
managed, domain-joined Computer from its detail page, and OPUS captures the
recovery key(s) into two places — **Active Directory** (the authoritative
system of record, same recovery path IT already uses with `manage-bde`) and the
**H2Tecs database** (encrypted-at-rest, so a lost/unreachable DC does not leave
us without a key, and so keys are viewable in the UI with an audit trail). A
new **Security → BitLocker Keys** page lists every key the fleet has escrowed
to us, with click-to-reveal + audit log, and the existing compliance tab (spec
21) gains an **Enable BitLocker** action.

The script that does the enablement — `scripts/windows/enable-bitlocker.ps1` —
ships in the repo. The collector `worker` runs it against the target over the
same WinRM channel it already uses to scan and to push software (spec 23) and
printer installs (spec 20), parses its single-line `H2TECS_BITLOCKER_RESULT`
JSON, backs up the key to AD on the target *and* forwards the key to
`/api/ingest/bitlocker` for DB escrow.

It keeps the **outbound-only** posture of every other collector feature: the
web app never connects into the fleet — the **collector dials out** for the
job, runs the script on the target, and posts the result back.

> **Honest scope note (read first).** The script itself only enables BitLocker
> on the **system drive** with a **TPM + RecoveryPassword** protector set and
> requires a domain-joined machine with a usable TPM. Data drives, BitLocker-To-Go
> (removable), `PIN`/`StartupKey` protectors, suspend/resume, and bulk rotation
> of recovery passwords are **Follow-ups**. Changing encryption method on an
> already-encrypted drive is also out of scope — we accept whatever state the
> drive is in and just ensure a recovery password exists + is escrowed.

## Requirements

**User stories**:
- As an IT admin, I want to enable BitLocker on a managed computer from its
  detail page, so I do not have to RDP in and run `manage-bde` by hand.
- As an IT admin, I want the recovery key saved both to AD **and** to H2Tecs,
  so if a DC is unreachable I can still unlock a user's laptop.
- As an IT admin, I want a single page that lists every BitLocker recovery key
  H2Tecs has, grouped by computer, so I can find a key fast on a support call.
- As a security owner, I want recovery keys **encrypted at rest**, revealed
  only by an explicit click, and every reveal written to an audit log with who
  and when.
- As an IT admin, I want a machine that is **not** domain-joined to be refused
  rather than silently given a recovery password that only exists on H2Tecs.

**Acceptance criteria** (each independently checkable):
- **AC-1**: The target-side script `scripts/windows/enable-bitlocker.ps1`
  refuses on a non-domain-joined machine (exit 10) and on a machine without a
  TPM-ready chip (exit 11, overridable via `-AllowNoTpm`). It is idempotent: if
  the system drive is already fully encrypted, it does **not** re-enable; it
  only ensures a `RecoveryPassword` protector exists and backs each one up to
  AD.
- **AC-2**: The script's single JSON result line (`H2TECS_BITLOCKER_RESULT …`)
  carries, per drive: mount point, encryption method, protection status,
  encryption %, every key protector's id + type, each `RecoveryPassword`
  protector's password + AD-backup result (`ok`/`failed`/`skipped`), and a UTC
  timestamp. A total AD-backup failure (every protector failed) is a hard exit
  (14) — the operator sees a red result, not a false green.
- **AC-3**: An admin holding the new `bitlocker:write` scope can trigger
  enablement from a Computer's detail page. This creates a `bitlocker_jobs`
  row (`pending`) with a frozen snapshot of `assetId`, requested options, and
  requester. A non-Computer, a Computer without a resolvable
  `computer_details.ipAddress`, or a Computer the collector cannot reach over
  WinRM disables the control and the action refuses (422).
- **AC-4**: The collector worker claims one pending BitLocker job at a time
  atomically (`FOR UPDATE SKIP LOCKED`), fenced by `workerId` + `claimedAt`,
  exactly like scan / printer-install / software-deploy jobs. A stuck claim is
  reaped back to `pending` or `failed` by the same reaper used by the other
  job types, so a crashed worker never strands a job.
- **AC-5**: The worker stages the PS1 into the target (same SMB-admin-share /
  base64-over-WinRM path spec 20 and spec 23 already use), runs it elevated,
  captures stdout, finds the `H2TECS_BITLOCKER_RESULT` line, and POSTs the
  parsed payload to `POST /api/ingest/bitlocker` with its service-account
  token (new scope `ingest:bitlocker`). The temp PS1 is deleted on exit, pass
  or fail.
- **AC-6**: `POST /api/ingest/bitlocker` verifies the service token, upserts
  per `(assetId, mountPoint)` into `bitlocker_keys`, and keeps **history**: a
  new `bitlocker_key_versions` row is written for every recovery password that
  changes, with `rotatedAt`, so rotation is auditable. The `bitlocker_keys`
  row carries current state (protection status, encryption %, AD-backup
  status, last-assessed); the recovery password itself is stored **encrypted
  at rest** (see below) in `bitlocker_key_versions.recoveryPasswordCt`.
- **AC-7**: The Computer detail **Compliance** tab (spec 21) gains an **Enable
  BitLocker** button when the drive is 🔴/⚪ and the user holds
  `bitlocker:write`. It becomes a **Rotate recovery key** button when the
  drive is 🟢 and we already have a key stored. Both open a confirm dialog with
  the target host, mount point, and options.
- **AC-8**: A new `/security/bitlocker` page (gated by `bitlocker:read`) lists
  every escrowed key: computer, mount point, domain, protection status,
  encryption %, `lastAssessedAt`, AD backup status chip, and a **Reveal key**
  button. The key is **not** on the page by default — it is fetched by a
  separate `GET /api/bitlocker/keys/:id/reveal` call that (a) verifies
  `bitlocker:read`, (b) writes an audit-log row (who, when, assetId, keyId,
  ip), and (c) decrypts and returns the password. Revealing without that
  scope returns 403 and still writes the audit row (`denied`).
- **AC-9**: Every protector read into H2Tecs also lands in AD. When the
  script reports `ad_backup=failed` for any protector, the detail page and
  `/security/bitlocker` surface a yellow **"not in AD"** chip; it does **not**
  silently succeed just because we got the key into H2Tecs. The compliance
  score (spec 21) treats a drive encrypted-but-no-AD-backup as 🟡 warn, not 🟢.
- **AC-10**: Recovery passwords are encrypted using AES-256-GCM with a key
  loaded from `BITLOCKER_KEK` (env, 32 bytes base64) on the web server.
  `BITLOCKER_KEK` has **no default** — the web server refuses to boot if it is
  missing and spec-35 tables are present. Rotating the KEK is a documented
  runbook (re-encrypt every `bitlocker_key_versions` row under the new KEK,
  bump a `kekVersion` column).

## Data model

Three new Drizzle-managed tables in `aw_it_inventory_web`:

```ts
// Current state, 1:1 with (asset, mountPoint)
bitlocker_keys {
  id              uuid pk
  assetId         uuid fk → assets.id
  mountPoint      text            // 'C:'
  domain          text
  protectionStatus text            // 'On' | 'Off' | 'Unknown'
  volumeStatus    text             // 'FullyEncrypted' | 'EncryptionInProgress' | ...
  encryptionPct   int              // 0..100
  encryptionMethod text             // 'XtsAes128' | 'XtsAes256' | ...
  tpmPresent      boolean
  tpmReady        boolean
  adBackupStatus  text             // 'ok' | 'failed' | 'partial' | 'skipped'
  currentVersionId uuid fk → bitlocker_key_versions.id (nullable)
  lastAssessedAt  timestamptz
  createdAt       timestamptz default now()
  updatedAt       timestamptz
  unique(assetId, mountPoint)
}

// Full history of every RecoveryPassword protector we've seen.
bitlocker_key_versions {
  id                   uuid pk
  keyId                uuid fk → bitlocker_keys.id on delete cascade
  keyProtectorId       text             // AD KeyProtectorId GUID
  protectorType        text             // 'RecoveryPassword' (future: others)
  recoveryPasswordCt   bytea            // AES-256-GCM(password, BITLOCKER_KEK)
  recoveryPasswordIv   bytea            // 12 bytes
  recoveryPasswordTag  bytea            // 16 bytes
  kekVersion           int   default 1
  adBackup             text             // 'ok' | 'failed' | 'skipped'
  adBackupError        text
  seenAt               timestamptz
  rotatedOutAt         timestamptz      // null until a newer version supersedes it
  createdAt            timestamptz default now()
}

// Append-only audit log for key reveals.
bitlocker_key_reveals {
  id          uuid pk
  keyId       uuid fk → bitlocker_keys.id
  versionId   uuid fk → bitlocker_key_versions.id
  actorUserId uuid fk → users (nullable for service accts)
  actorEmail  text
  outcome     text              // 'revealed' | 'denied'
  ip          inet
  userAgent   text
  revealedAt  timestamptz default now()
}

// Job queue — mirrors software_deployments / printer_installs.
bitlocker_jobs {
  id              uuid pk
  assetId         uuid fk → assets.id
  action          text              // 'enable' | 'rotate'
  mountPoint      text default 'C:'
  encryptionMethod text default 'XtsAes128'
  usedSpaceOnly   boolean default false
  requestedBy     uuid fk → users
  status          text              // 'pending' | 'claimed' | 'running' | 'succeeded' | 'failed'
  workerId        text
  claimedAt       timestamptz
  startedAt       timestamptz
  finishedAt      timestamptz
  resultSummary   jsonb             // trimmed copy of the H2TECS_BITLOCKER_RESULT payload (no password)
  exitCode        int
  errorMessage    text
  createdAt       timestamptz default now()
}
```

**Password never lives in `bitlocker_jobs.resultSummary`.** The ingest handler
splits the parsed payload: the password goes straight into
`bitlocker_key_versions.recoveryPasswordCt` encrypted; the rest (status, pct,
protector ids, timestamps) is what the job row stores for auditability.

**Needs `npm run db:push`** on the web DB. See the gotcha in CLAUDE.md about
the auth DB.

## API

- `POST /api/bitlocker/jobs` — create an `enable` or `rotate` job for an
  asset. Requires `bitlocker:write`. Returns `{ jobId }`.
- `GET  /api/bitlocker/jobs/:id` — poll job status. Requires `bitlocker:write`
  or `asset:read` (own-asset).
- `GET  /api/bitlocker/keys` — list keys for the fleet (paginated). Requires
  `bitlocker:read`. Returns metadata only, **no passwords**.
- `GET  /api/bitlocker/keys/:id` — one key's full metadata + version history
  (still no password).
- `GET  /api/bitlocker/keys/:id/reveal` — returns `{ recoveryPassword }`.
  Requires `bitlocker:read`. Writes a `bitlocker_key_reveals` row every call.
  Rate-limited (10/min/user) to make scraping obvious in the audit log.
- `POST /api/ingest/bitlocker` — collector-only. Verified via JWKS +
  `ingest:bitlocker` scope. Upserts `bitlocker_keys`, appends a new
  `bitlocker_key_versions` row when the protector id is new, and updates
  `currentVersionId`.

## UI

- **Computer detail → Compliance tab** gains an **Enable BitLocker** button
  (🔴/⚪ states) or **Rotate recovery key** (🟢 state), both behind
  `bitlocker:write`. A **View recovery key** link shows when a key exists and
  the user has `bitlocker:read`; the link opens the same reveal flow used by
  `/security/bitlocker`.
- **`/security/bitlocker`** (`bitlocker:read`): `HeroHeader` + summary stat
  tiles (# computers with keys, # not in AD, # last-assessed in >30d, %
  encrypted) + a sortable table with per-row chips and a **Reveal** button.
  Reveal opens a modal that shows the password in a monospace box, an
  explicit **Copy** button, and the audit note "This reveal was logged as
  {you} at {time}". No auto-copy; no "remember for N minutes".
- **Jobs tab** on the same page lists recent BitLocker jobs (like
  `/software` has for deployments) so an admin can watch an enablement
  progress in near-real-time.

## Permissions

Two new codes under a new `bitlocker:*` family in `aw-auth/rbac/`:

| Code              | Grants                                                              |
|-------------------|---------------------------------------------------------------------|
| `bitlocker:write` | Create enable/rotate jobs; view job status and errors.              |
| `bitlocker:read`  | List keys, see metadata, **reveal** recovery password (audited).   |

Service-account scope `ingest:bitlocker` is added for the collector's
ingest call. The collector's existing service account gets it appended via
`set_service_account_scopes`.

The default **Admin** role gets both `bitlocker:*`; **Operator** gets
`bitlocker:write` only (they can enable but cannot see a password); **Viewer**
gets neither. These assignments are a seed, not a hard rule — adjustable in
`seed_rbac`.

## Phases

1. **Target script** — `scripts/windows/enable-bitlocker.ps1`, run by hand on
   a lab machine, output verified. No collector/web changes.
2. **Collector job runner** — `bitlocker_jobs` queue, worker claim + run +
   ingest POST, reusing the spec-20/-23 staging path. Still no UI; verify via
   DB + API.
3. **Ingest + encryption** — `/api/ingest/bitlocker`, `bitlocker_keys` +
   `bitlocker_key_versions`, AES-GCM wrapper, `BITLOCKER_KEK` env.
4. **UI: compliance tab actions + reveal modal** — enable/rotate buttons,
   view-key flow with audit row.
5. **UI: `/security/bitlocker` fleet page** — tiles, table, filters, jobs
   sub-tab.

Each phase is independently mergeable; phase 1 is useful on its own.

## Out of scope (follow-ups)

- Data drives, BitLocker-To-Go (removable), non-system volumes.
- `PIN` / `StartupKey` protectors; passwordless setups.
- Scheduled bulk enrollment across the fleet (this spec is per-machine on
  demand; the queue machinery can carry a scheduled push later).
- **Disable / decrypt** flow — deliberately not built in v1; a key removal is
  a high-risk action that deserves its own spec.
- KEK rotation in the UI; v1 is a runbook (export/decrypt/re-encrypt/import).
- Non-Windows disk encryption (FileVault, LUKS) — separate specs.

## Gotchas / dependencies

- **GPO for AD escrow.** `Backup-BitLockerKeyProtector` succeeds only when the
  computer object has the schema extensions and the admin running the
  enablement has permission to write `msFVE-RecoveryInformation` under the
  computer object. If AD escrow fails, AC-9 surfaces it as a yellow chip
  rather than hiding it. The onboarding runbook needs a one-liner on the
  required GPO ("Choose how BitLocker-protected operating system drives can
  be recovered" → "Save BitLocker recovery information to AD DS").
- **TPM + UAC token.** The compliance signal already discovered this — on a
  UAC-token-filtered machine, enablement will fail the same way reads fail.
  Reuse the `LocalAccountTokenFilterPolicy` note from the onboarding runbook.
- **`Enable-BitLocker` is non-blocking.** It kicks off encryption and returns
  immediately. The script does not wait for `FullyEncrypted` — we report
  `encryption_pct` as of the moment the script exits and rely on the next
  compliance collect (spec 21) to show encryption completing in the UI.
- **Already-encrypted drives.** If a drive was encrypted outside H2Tecs and
  does not have a `RecoveryPassword` protector, the script adds one with
  `Add-BitLockerKeyProtector` then escrows it. This is the normal path for
  retrofitting existing fleet machines.
- **Secrets in transit.** The recovery password leaves the target over the
  encrypted WinRM channel (collector → target), then the collector forwards
  it to the web app over TLS. It is never written to disk on either hop. The
  target script explicitly warns against persisting the JSON on the target.
- **`BITLOCKER_KEK`** must be managed like any production secret: 32 bytes
  of random base64, stored outside the repo, backed up separately. Loss of
  the KEK invalidates every stored recovery password — AD remains the
  authoritative copy, which is exactly why we escrow to both.

## Related

- [20](../20-remote-printer-install/index.md) remote printer install (the
  staging + claim/reap pattern this reuses).
- [21](../21-compliance/index.md) compliance (the BitLocker *read* path; this
  spec adds the *write* path and the key store the compliance tab links to).
- [23](../23-software-deployment/index.md) software deployment (the same
  queue + WinRM + ingest-POST shape).
- [24](../24-remote-actions/index.md) remote actions (another
  `remote:*`-style high-risk permission family — the UX pattern for gated,
  audited operations).
- `docs/runbooks/onboard-computer.md` (the admin-token + GPO dependency).
