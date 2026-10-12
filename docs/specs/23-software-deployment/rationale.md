# 23. Software Deployment — rationale

Why the choices in [index.md](index.md), and the options weighed. This feature is
deliberately shaped to be **spec 20 (printer install) with an uploaded payload** —
so most decisions are "reuse what already works" and the interesting ones are about
the installer bytes and the MSI/EXE difference.

## 1. Where the installer comes from: upload + library vs filesystem drop

- **Filesystem drop (what printer drivers do, spec 20).** Admin drops files in a
  `drivers/`-style dir; the web reads manifests. Zero upload UI, but it needs
  server filesystem access the admin may not have, doesn't fit "upload from my
  laptop," and has no per-file metadata/versioning. Wrong fit for end-user software
  that admins acquire as single installers.
- **Upload + a library catalog (chosen).** The admin uploads an MSI/EXE through the
  UI; it lands in object storage with a catalog row (name, version, type, args,
  size, sha256). Matches how admins actually get installers, gives versioning and
  an approved list, and keeps integrity (sha256) first-class. The cost is an upload
  path + a catalog table — small, and it reuses the media upload/storage pattern.

**Chosen: upload + library.** It's what the user asked for ("uploaded installer")
and what the workflow needs.

## 2. Where the bytes live: object store vs DB blob vs filesystem

- **DB blob (`bytea`).** Simple transactionally, but installers are tens–hundreds of
  MB; Postgres blobs bloat the DB, the backups, and the connection memory. No.
- **Server filesystem.** Works, but it's another stateful path to back up and
  doesn't exist in a container/multi-node future; the app already standardized media
  on object storage.
- **S3-compatible object store (chosen).** `lib/storage.ts` already talks the S3 API
  to a self-hosted store (Garage/SeaweedFS/…) for media, private, served only through
  authenticated routes. Reuse it: a generic `putObject/getObjectBytes/removeObject`
  beside the image helpers, a random key, a size cap, and an installer type
  allow-list. The DB keeps only metadata + the key + the hash.

**Chosen: object store, metadata in Postgres.** Same store as media, no new infra.

## 3. Getting the installer onto the target: reuse spec-20 transfer

The collector already solves "get a file into a Windows box over the scan channel":
`install_printer._stage` does **SMB admin-share copy** (fast, `smbprotocol` is a
dep) with a **base64-over-WinRM fallback** (slow, universal), then verifies a
content hash. Software deployment is the same problem with a single file instead of
a zipped folder, so it reuses that path verbatim.

Alternatives considered and rejected for v1:
- **Target pulls over HTTP/WebDAV from the web app.** Would mean the *target*
  reaching the web app — a new inbound-ish path and target-side config; breaks the
  "only the collector talks to the web" shape.
- **PSExec / GPO / SCCM / Intune.** Existing enterprise tooling, but that's a
  different product; OPUS's value here is doing it through the one agentless channel
  it already has, with its own audit and library.

**Chosen: collector pulls the bytes from the web (service-scoped), transfers via the
spec-20 SMB/base64 path, verifies sha256 on target.** The pull endpoint **streams**
the file (not base64-in-JSON) because installers are large.

## 4. Permission & service scope

- **UI permission.** Printer install uses `printer:install`, granted to **Owner and
  Admin** — installing software is the same tier of routine admin action, so
  software deployment gets its own **`software:deploy`**, seeded to Owner + Admin.
  (Contrast spec 24's `remote:shell`, which is Owner-only: an arbitrary interactive
  shell is strictly more dangerous than running a *vetted, hash-verified* installer
  from an approved library.)
- **Service scope.** Printer install reused `scan:dequeue` for its worker endpoints.
  Spec 24 set a newer precedent: a code-execution feature gets its **own** agent
  scope (`remote:agent`) for least privilege. Software deployment is code execution,
  so it gets **`deploy:agent`**, distinct from `scan:dequeue`, so a token minted for
  scanning can't drive deployments and vice-versa. The cost is one more scope to
  grant on the collector account (`set_service_account_scopes`), which is cheap and
  already routine.

**Chosen: `software:deploy` (Owner + Admin) + a dedicated `deploy:agent` scope.**
Reusing `scan:dequeue` (as printer install does) is the simpler alternative and is
noted here; we take the least-privilege split to match the spec-24 direction.

## 5. MSI vs EXE — the honest hard part

- **MSI is standardized.** `msiexec /i <file> /qn /norestart` silently installs any
  well-formed MSI, with documented exit codes (`0` success, `3010` success +
  reboot-required, `1641` reboot-initiated, `1618` another install in progress,
  `1603` fatal). OPUS can interpret these generically.
- **EXE is not.** An EXE installer is an arbitrary program; its silent switch and
  exit codes are whatever its author chose (InnoSetup `/VERYSILENT /SUPPRESSMSGBOXES`,
  NSIS `/S`, InstallShield `/s /v"/qn"`, WiX burn `/quiet`, …). There is **no
  universal silent flag**. So OPUS cannot reliably silence or judge an arbitrary EXE
  on its own.

**Decision**: an **MSI** package needs no args (the worker supplies `/qn
/norestart`, overridable); an **EXE** package **requires** the admin to enter the
correct silent args at upload, and OPUS runs exactly those and reports the raw exit
code. Because EXE exit codes aren't trustworthy as a success signal, the worker also
does a **best-effort post-install registry check** (Uninstall keys) to detect the
installed version — so "succeeded" can be corroborated by "the program now appears
installed," not just "exit 0." This limitation is stated up front in the index's
scope note; pretending EXE installs are uniform would be the dishonest choice.

## 6. One-at-a-time per target, reaper, cancel — reuse

All three are inherited from the scan/printer queue: the partial index on in-flight
status gives a cheap "is a deploy already running on this computer" read; the reaper
requeues/fails a job whose worker went silent past the timeout; cancel flips the row
to `canceled`, and because the worker's result post is fenced on
`workerId`+`claimedAt`+`status in (claimed,running)`, a late result cleanly no-ops.
Nothing new to design — just applied to the new table.

## 7. Deleting a package that history references

Deployment history freezes a **snapshot** of the package, so history stays readable
even if the catalog row and the object are deleted. But to keep the library tidy
without orphaning the UI, delete is a **soft-guard**: the object bytes are removed
(reclaim storage) and the catalog row is **archived** (`archivedAt`) rather than
hard-deleted when any deployment references it, so the library hides it but history
can still resolve its name/version. A package with no history can be hard-deleted.

## 8. What this is not (deferred — see index Follow-up)

Multi-target fleet rollout, scheduling/maintenance windows, uninstall/repair,
dependency chains, detection-rule skipping, and Authenticode verification are all
real and valuable, but each is additive on top of the single-target deploy this
spec builds. Shipping the one-computer path first keeps the tracer thin and proves
the upload→store→pull→transfer→verify→install→report thread before widening it.
