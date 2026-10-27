# Spec 23 polish — conditions, timeouts, templates, break-glass export

**Date**: 2026-10-27  
**Status**: Design approved; plan at [`../plans/2026-10-27-software-deploy-polish.md`](../plans/2026-10-27-software-deploy-polish.md)  
**Parent**: [Spec 23 — Software deployment](../../specs/23-software-deployment/index.md)  
**Motivates**: Wise ePad fleet packaging (idempotent uninstall/install, hung
InstallShield, Chrome/Edge policy scripts, offline break-glass)

## Goal

Make Software Library packages safer and easier to author, and allow an admin to
**export a standalone PowerShell install script** that pulls package files from
H2Tecs via short-lived signed URLs when the collector path is unavailable.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Scope | Conditions + timeouts + templates + export (all) |
| Work shape | One design; **three shippable slices** (PRs) |
| Skip condition | `skipIf.product_installed` via Uninstall DisplayName |
| Timeout | Per-step wall clock; default 900s; fail step + best-effort kill |
| Templates | Client-side presets that insert steps (no template DB in v1) |
| Export purpose | Break-glass: run `.ps1` on a target with network to H2Tecs |
| File delivery in export | Runtime download via **app-signed HTTPS URLs** (not public Seaweed, not zip bundle) |
| AI | Optional Spec 34 **comments only** on a deterministic script |

## Non-goals

- Fleet multi-target schedule / maintenance windows (still Spec 23 follow-up)
- AI-authored install commands
- Spec 33 portal / Spec 31 WSUS (won't-do)
- `skipIf` for “product **absent**” (v1 only skips when installed)
- Changing SMB / self-target local-copy behavior beyond timeouts applying to it

## Slices

### Slice 1 — Safe & idempotent

**Skip-if-installed** and **step timeout** on collector + web schema/UI + deploy results.

### Slice 2 — Authoring templates

“Add from template” presets in the package editor (InstallShield uninstall+install,
Chrome+Edge ExtensionSettings, Enable .NET 3.5).

### Slice 3 — Break-glass export

Export `.ps1` + HMAC-signed `export-file` download routes; optional AI commentary.

---

## Data model

Extend both `script` and `install` arms of `SoftwareStep` (JSON on
`software_packages.steps` and frozen `package_snapshot`):

```ts
timeoutSec?: number; // omitted → default 900; collector enforces
skipIf?: {
  type: "product_installed";
  displayName: string;              // e.g. "ePadLink ePad"
  displayNameMatch?: "eq" | "prefix"; // default "eq"
  displayVersion?: string;          // optional exact version gate
};
```

`continueOnError` unchanged. Prefer `skipIf` for “already installed”; use
`continueOnError` for true failures that should not stop the package (e.g.
uninstall when nothing to remove — until a future “skip if absent”).

No new Postgres tables for templates or exports in v1.

Deploy step results gain a first-class **`skipped`** status (reason
`product_installed` in `outputTail` or a small structured field if already
present on the result type).

---

## Collector / runtime (slice 1)

For each step, in order:

1. **`skipIf`** (if set) — elevated WinRM: probe
   `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*` and
   `WOW6432Node\…`. If DisplayName matches → append
   `{ status: "skipped", … }`, **do not** download/transfer/run; continue.
2. **Transfer** (install only) — existing SMB / self-target local / base64 path.
3. **Run under timeout** — wall clock from step start (default 900s).
   - Script and install both covered.
   - On expiry: mark step `failed` with `timed_out` in output; best-effort
     `Stop-Process` for `setup` / `msiexec` associated with that staging dir
     when identifiable; then honor `continueOnError`.
4. **Normal failure / success** — existing behavior.

Self-target local staging (merged #128) remains; timeouts still apply.

---

## UI (slices 1–2)

### Package editor

- Per step: timeout (minutes UI → `timeoutSec`).
- Per step: “Skip if installed” (DisplayName, match mode, optional version).
- Deploy history: **Skipped** badge distinct from OK / Failed.

### Templates (“Add from template”)

Client constants; inserting steps only — admin still uploads EXE/companions:

| Preset | Inserts |
|---|---|
| Enable .NET 3.5 | Script: NetFx3 optional-feature snippet |
| Chrome + Edge ePad extension | Script: HKLM ExtensionSettings `normal_installed` for Chrome + Edge (literal JSON, no ConvertTo-Json depth trap) |
| InstallShield uninstall + install | Two install steps: uninstall silent args + uninstall `.iss` companion slot (`continueOnError` on); install silent args + install `.iss`; optional `skipIf` on install |

### Export control (slice 3)

On package view/edit: **Export install script** (`software:deploy`). Optional
“Add AI comments” when Spec 34 is configured. Downloads `.ps1`; toast notes URL TTL.

---

## Break-glass export (slice 3)

### Script contents (deterministic)

1. Require elevation.
2. Create a temp work directory.
3. For each install step (and companions): download via signed HTTPS URL into work dir.
4. Same order as collector: `skipIf` probe → run silent args / script with work dir as `%DIR%`.
5. Per-step logging; process exit non-zero if a non-`continueOnError` step fails.
6. Optional AI preface/comments only (warnings); never rewrite commands. If AI off or fails, export still succeeds without comments.

### Signed download URLs

Private object store stays private. Web mints:

`GET /api/software/packages/:id/export-file?file=<fileName>&exp=<unix>&sig=<hmac>`

- HMAC over `(packageId, storageKey or fileName, exp)` with a server secret
  (e.g. `SOFTWARE_EXPORT_SIGNING_SECRET` or derived from existing secret material).
- TTL default **1 hour** (env-configurable).
- Handler verifies signature + expiry, resolves file from package steps
  (installer or companion), streams bytes. **No cookie required** on the target —
  the signature is the capability.
- Only files belonging to that package at export time are reachable.

Re-export after expiry. Does not embed admin session cookies.

### Auth for “Export” button

Creating the `.ps1` (and thus minting sigs) requires cookie session +
`software:deploy`. Running the script on an endpoint does not.

---

## Testing

- **Unit**: `parseSteps` accepts/rejects `skipIf` / `timeoutSec`; skip probe match
  helpers; HMAC mint/verify + expired sig; script generator includes steps in order
  and `%DIR%` substitution.
- **Collector**: skip short-circuits download; timeout marks `timed_out` (mocked clock
  / fake long run); `continueOnError` after timeout.
- **UI**: template insert; skipped badge in deploy panel (mocked results).
- **Manual**: Wise-like package — install twice with `skipIf` on install steps;
  hung setup killed by timeout; export script downloads and installs on a lab host.

## Rollout

1. Slice 1 PR → merge  
2. Slice 2 PR → merge  
3. Slice 3 PR → merge  

Update Spec 23 Follow-up / PROGRESS when each slice ships.

## Open questions (none blocking)

- Exact HMAC payload encoding (canonical string) — plan detail.
- Whether timeout kill enumerates by path under staging dir or by process start
  time — plan detail; best-effort is enough for v1.
