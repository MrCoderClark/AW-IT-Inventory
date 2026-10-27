# Spec 23 polish — conditions, timeouts, templates, export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Idempotent skip-if-installed + step timeouts, package editor templates, and break-glass `.ps1` export with short-lived signed download URLs (optional AI comments).

**Architecture:** Extend `SoftwareStep` JSON (`skipIf`, `timeoutSec`); collector evaluates skip before transfer and wraps run in a wall-clock timeout; UI exposes fields + templates; export mints HMAC URLs and a deterministic PowerShell generator (Spec 34 comments optional).

**Tech Stack:** Next.js App Router, Drizzle JSON types, Vitest, collector Python/WinRM, existing SeaweedFS via `getObjectBytes`.

**Spec:** [`docs/superpowers/specs/2026-10-27-software-deploy-polish-design.md`](../specs/2026-10-27-software-deploy-polish-design.md)

## Global Constraints

- Three slices / PRs: (1) skip + timeout, (2) templates, (3) export
- Default `timeoutSec` = **900** when omitted
- `skipIf.type` v1 = **`product_installed` only** (Uninstall DisplayName)
- Export downloads: **app HMAC URLs**, TTL default **3600**s; no public Seaweed
- AI: **comments only**, never rewrite install commands; export works if AI off
- Permission: `software:deploy` to edit/export; signed GET needs no cookie
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell; quote `(app)` paths; user runs servers/tests unless asked
- Branch from `main`: `feat/software-deploy-polish` (or per-slice branches off it)
- Do not commit Spec 33/31 won't-do follow-ups into this work

---

## File structure

| File | Role |
|---|---|
| `web/src/db/schema.ts` | `SoftwareStep` + `SoftwareStepResult.reason` |
| `web/src/lib/software-package-steps.ts` | Parse `skipIf` / `timeoutSec` |
| `web/src/lib/software-package-steps.test.ts` | Create — parse validation |
| `web/src/components/software-library.tsx` | Editor fields + templates + export button |
| `web/src/components/software-deploy-panel.tsx` | Skipped / timed_out display |
| `collector/software_deploy.py` | skip probe, timeout wrapper, kill best-effort |
| `collector/tests/test_software_deploy.py` | skip + timeout tests |
| `web/src/lib/software-export-sign.ts` | Create — HMAC mint/verify |
| `web/src/lib/software-export-script.ts` | Create — PS1 generator |
| `web/src/app/api/software/packages/[id]/export/route.ts` | Create — returns `.ps1` |
| `web/src/app/api/software/packages/[id]/export-file/route.ts` | Create — signed file GET |
| `docs/specs/23-software-deployment/index.md` | Follow-up note when slices ship |
| `PROGRESS.md` | Mark slices as they merge |

---

# Phase 1 — Safe & idempotent (slice 1)

### Task 1: Schema + parseSteps for skipIf / timeoutSec

**Files:**
- Modify: `web/src/db/schema.ts` (`SoftwareStep`, `SoftwareStepResult`)
- Modify: `web/src/lib/software-package-steps.ts`
- Create: `web/src/lib/software-package-steps.test.ts`

**Interfaces:**
- Produces: optional `timeoutSec?: number` and `skipIf?: { type: "product_installed"; displayName: string; displayNameMatch?: "eq" | "prefix"; displayVersion?: string }` on both step kinds; `SoftwareStepResult.reason?: "cascade" | "product_installed" | "timed_out"`

- [ ] **Step 1: Extend types in `schema.ts`**

On both `script` and `install` step objects, add optional `timeoutSec?` and `skipIf?` as in the design. Update `SoftwareStepResult`:

```ts
export type SoftwareStepResult = {
  stepId: string;
  name: string;
  kind: "script" | "install";
  status: "ok" | "failed" | "skipped";
  /** cascade = prior failure stopped the package; product_installed = skipIf; timed_out on failed */
  reason?: "cascade" | "product_installed" | "timed_out";
  exitCode: number | null;
  outputTail: string;
};
```

Update the comment on `status` — `skipped` is no longer only cascade.

- [ ] **Step 2: Failing parse tests**

Create `web/src/lib/software-package-steps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSteps } from "./software-package-steps";

describe("parseSteps — skipIf / timeoutSec", () => {
  it("accepts skipIf + timeoutSec on install", () => {
    const r = parseSteps([
      {
        kind: "install",
        name: "UI13",
        installerType: "exe",
        fileName: "a.exe",
        silentArgs: "/S",
        storageKey: "k",
        sha256: "a".repeat(64),
        fileSize: 1,
        timeoutSec: 600,
        skipIf: {
          type: "product_installed",
          displayName: "ePadLink ePad",
          displayNameMatch: "eq",
        },
      },
    ]);
    expect("steps" in r).toBe(true);
    if (!("steps" in r)) return;
    const s = r.steps[0];
    expect(s.kind).toBe("install");
    if (s.kind !== "install") return;
    expect(s.timeoutSec).toBe(600);
    expect(s.skipIf).toEqual({
      type: "product_installed",
      displayName: "ePadLink ePad",
      displayNameMatch: "eq",
    });
  });

  it("rejects unknown skipIf.type", () => {
    const r = parseSteps([
      {
        kind: "script",
        name: "x",
        script: "Write-Output 1",
        skipIf: { type: "nope", displayName: "X" },
      },
    ]);
    expect("error" in r).toBe(true);
  });

  it("rejects empty displayName", () => {
    const r = parseSteps([
      {
        kind: "script",
        name: "x",
        script: "Write-Output 1",
        skipIf: { type: "product_installed", displayName: "  " },
      },
    ]);
    expect("error" in r).toBe(true);
  });

  it("rejects non-positive timeoutSec", () => {
    const r = parseSteps([
      {
        kind: "script",
        name: "x",
        script: "Write-Output 1",
        timeoutSec: 0,
      },
    ]);
    expect("error" in r).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

```powershell
cd web; npm test -- src/lib/software-package-steps.test.ts
```

Expected: FAIL (parse does not yet emit skipIf/timeoutSec / reject bad values).

- [ ] **Step 4: Implement parse helpers + wiring**

In `software-package-steps.ts`, add:

```ts
function parseTimeoutSec(
  raw: unknown,
  stepLabel: string,
): { timeoutSec?: number } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
    return { error: `${stepLabel}: timeoutSec must be a positive number` };
  return { timeoutSec: Math.floor(raw) };
}

function parseSkipIf(
  raw: unknown,
  stepLabel: string,
): { skipIf?: SoftwareStep extends { skipIf?: infer S } ? S : never } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || raw === null)
    return { error: `${stepLabel}: skipIf is malformed` };
  const o = raw as Record<string, unknown>;
  if (o.type !== "product_installed")
    return { error: `${stepLabel}: skipIf.type must be product_installed` };
  const displayName = typeof o.displayName === "string" ? o.displayName.trim() : "";
  if (!displayName) return { error: `${stepLabel}: skipIf.displayName is required` };
  const displayNameMatch = o.displayNameMatch === "prefix" ? "prefix" : "eq";
  const displayVersion =
    typeof o.displayVersion === "string" && o.displayVersion.trim()
      ? o.displayVersion.trim()
      : undefined;
  return {
    skipIf: {
      type: "product_installed",
      displayName,
      displayNameMatch,
      ...(displayVersion ? { displayVersion } : {}),
    },
  };
}
```

(Use an explicit inline type for `skipIf` matching schema instead of the conditional if cleaner.)

Merge into both `steps.push({...})` for script and install: spread `timeout` / `skip` results or return error.

- [ ] **Step 5: Run tests — expect PASS**

```powershell
cd web; npm test -- src/lib/software-package-steps.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add -- web/src/db/schema.ts web/src/lib/software-package-steps.ts web/src/lib/software-package-steps.test.ts
git commit -m "feat(deploy): parse skipIf and timeoutSec on package steps`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Collector skipIf + timeout

**Files:**
- Modify: `collector/software_deploy.py`
- Modify: `collector/tests/test_software_deploy.py`

**Interfaces:**
- Consumes: step `skipIf`, `timeoutSec` from snapshot
- Produces: step results with `status: "skipped"`, `reason: "product_installed"`; or `status: "failed"`, `reason: "timed_out"`; cascade skips set `reason: "cascade"`

- [ ] **Step 1: Failing tests for skip and timeout**

Add to `test_software_deploy.py` (reuse `_patch_common`):

```python
def test_skip_if_product_installed_skips_without_download(monkeypatch):
    _patch_common(monkeypatch)
    downloaded = {"n": 0}
    monkeypatch.setattr(
        software_deploy,
        "_download_file",
        lambda *a, **k: downloaded.__setitem__("n", downloaded["n"] + 1) or DATA,
    )
    monkeypatch.setattr(
        software_deploy,
        "_product_installed",
        lambda session, skip: True,
    )
    step = {
        **_install("s1"),
        "skipIf": {"type": "product_installed", "displayName": "App"},
    }
    status, result = software_deploy.run_deployment(
        Config(ingest_url="http://web"), "tok", _job([step])
    )
    assert status == "succeeded"
    assert result["steps"][0]["status"] == "skipped"
    assert result["steps"][0]["reason"] == "product_installed"
    assert downloaded["n"] == 0


def test_run_with_timeout_raises():
    def slow():
        import time
        time.sleep(2)
        return (0, "", "")
    try:
        software_deploy._run_with_timeout(0.05, slow)
        assert False, "expected timeout"
    except software_deploy.StepTimeoutError:
        pass


def test_step_timeout_marks_timed_out(monkeypatch):
    _patch_common(monkeypatch)

    def boom(*_a, **_k):
        raise software_deploy.StepTimeoutError("timed out")

    monkeypatch.setattr(software_deploy, "_run_with_timeout", boom)
    step = {**_script("s1"), "timeoutSec": 1}
    status, result = software_deploy.run_deployment(
        Config(ingest_url="http://web"), "tok", _job([step])
    )
    assert status == "failed"
    assert result["steps"][0]["status"] == "failed"
    assert result["steps"][0]["reason"] == "timed_out"
```

Implement `StepTimeoutError` and `_run_with_timeout` so both tests pass.
- [ ] **Step 2: Run pytest — expect FAIL**

```powershell
cd collector; uv run pytest tests/test_software_deploy.py -q
```

- [ ] **Step 3: Implement probe + timeout + orchestration**

Add to `software_deploy.py`:

```python
DEFAULT_STEP_TIMEOUT_SEC = 900

class StepTimeoutError(Exception):
    pass

def _product_installed(session: winrm.Session, skip: dict) -> bool:
    name = (skip.get("displayName") or "").replace("'", "''")
    match = skip.get("displayNameMatch") or "eq"
    ver = (skip.get("displayVersion") or "").replace("'", "''")
    # PowerShell: enumerate Uninstall keys; compare DisplayName eq/prefix; optional version
    ...
    r = _ps(session, script)
    return "FOUND" in (r.get("stdout") or "")


def _run_with_timeout(timeout_sec: int, fn):
    """Run fn() in a thread; raise StepTimeoutError if it exceeds timeout_sec."""
    ...
```

In `run_deployment` loop, before transfer:

```python
skip = step.get("skipIf")
if skip and skip.get("type") == "product_installed":
    if _product_installed(session, skip):
        results.append({
            **base,
            "status": "skipped",
            "reason": "product_installed",
            "exitCode": None,
            "outputTail": "skipIf: product_installed",
        })
        continue

timeout = int(step.get("timeoutSec") or DEFAULT_STEP_TIMEOUT_SEC)
try:
    if step["kind"] == "script":
        code, out, err = _run_with_timeout(
            timeout, lambda: _run_script(session, step.get("script") or "")
        )
    else:
        # download+put inside or outside timeout? Spec: wall clock for step —
        # include transfer+run under one deadline.
        def _install_body():
            ... existing download/put/run ...
            return code, out, err
        code, out, err = _run_with_timeout(timeout, _install_body)
except StepTimeoutError:
    # best-effort kill remote setup/msiexec
    _ps(session, "Get-Process setup,msiexec -EA SilentlyContinue | Stop-Process -Force")
    results.append({
        **base,
        "status": "failed",
        "reason": "timed_out",
        "exitCode": None,
        "outputTail": "timed_out",
    })
    failure = failure or "install-failed"
    stopped = not step.get("continueOnError")
    continue
```

When appending cascade skips (`if stopped:`), set `"reason": "cascade"`.

- [ ] **Step 4: Run pytest — expect PASS**

```powershell
cd collector; uv run pytest tests/test_software_deploy.py -q
```

- [ ] **Step 5: Commit**

```powershell
git add -- collector/software_deploy.py collector/tests/test_software_deploy.py
git commit -m "feat(deploy): skipIf product_installed and per-step timeout`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Package editor UI — skipIf + timeout

**Files:**
- Modify: `web/src/components/software-library.tsx`
- Modify: `web/src/components/software-deploy-panel.tsx`

**Interfaces:**
- Consumes: EditorStep fields mirroring schema; payload includes skipIf/timeoutSec on save

- [ ] **Step 1: Extend `EditorStep` and hydrate/save**

Add to both editor step variants:

```ts
timeoutSec: number; // UI stores minutes*60 or raw seconds — use seconds; label "Timeout (minutes)" with conversion
skipIfEnabled: boolean;
skipIfDisplayName: string;
skipIfMatch: "eq" | "prefix";
skipIfVersion: string;
```

In `toEditorSteps`, map from `s.skipIf` / `s.timeoutSec` (default timeoutSec 900). On save payload, if `skipIfEnabled && displayName.trim()`, emit `skipIf` object; always emit `timeoutSec` if ≠ default or always emit explicit value.

- [ ] **Step 2: Render controls under each step**

Beside continue-on-error: number input minutes (value = timeoutSec/60), checkbox “Skip if installed” + text fields for name / match / version.

- [ ] **Step 3: Deploy panel badges**

In `software-deploy-panel.tsx`, when `status === "skipped"` and `reason === "product_installed"`, label **Skipped (installed)**; when `reason === "cascade"` keep **Skipped**; when `failed` + `reason === "timed_out"` show **Timed out**.

- [ ] **Step 4: Commit**

```powershell
git add -- "web/src/components/software-library.tsx" "web/src/components/software-deploy-panel.tsx"
git commit -m "feat(deploy): UI for skipIf and step timeout`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Slice 1 docs + PR note

**Files:**
- Modify: `PROGRESS.md` (🚧 in progress or shipped note when merging)
- Modify: `docs/specs/23-software-deployment/index.md` Follow-up — check off or point at polish design

- [ ] **Step 1: Short PROGRESS / Follow-up blurb for slice 1**
- [ ] **Step 2: Commit + open PR for Phase 1 only**

```powershell
git commit -m "docs: note software-deploy polish slice 1`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# Phase 2 — Templates (slice 2)

### Task 5: Package step templates

**Files:**
- Create: `web/src/lib/software-package-templates.ts`
- Create: `web/src/lib/software-package-templates.test.ts`
- Modify: `web/src/components/software-library.tsx`

**Interfaces:**
- Produces: `PACKAGE_TEMPLATES: { id, label, description, buildSteps: () => EditorStepPartial[] }`
- Consumes: editor `setSteps` / append helpers

- [ ] **Step 1: Failing test — template ids and NetFx script content**

```ts
import { PACKAGE_TEMPLATES } from "./software-package-templates";

it("includes netfx, chrome-edge, installshield presets", () => {
  expect(PACKAGE_TEMPLATES.map((t) => t.id).sort()).toEqual(
    ["chrome-edge-extension", "enable-netfx35", "installshield-uninstall-install"].sort(),
  );
});
```

- [ ] **Step 2: Implement templates**

- `enable-netfx35`: script with the NetFx3 snippet from ops.
- `chrome-edge-extension`: full Chrome+Edge ExtensionSettings script (literal here-string JSON, both HKLM policy paths).
- `installshield-uninstall-install`: two install-shaped editor stubs with empty file slots, uninstall silent args `/s /f1"%DIR%\uninstall.iss"`, install `/s /f1"%DIR%\install.iss" /v"/qn"`, uninstall `continueOnError: true`, install optional skipIf placeholder fields empty for admin to fill.

- [ ] **Step 3: UI — “Add from template” dropdown** that appends `buildSteps()` results (new uiIds via `crypto.randomUUID()`).

- [ ] **Step 4: Commit**

```powershell
git commit -m "feat(deploy): package editor step templates`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# Phase 3 — Break-glass export (slice 3)

### Task 6: HMAC sign / verify

**Files:**
- Create: `web/src/lib/software-export-sign.ts`
- Create: `web/src/lib/software-export-sign.test.ts`
- Modify: `web/.env.example` — document `SOFTWARE_EXPORT_SIGNING_SECRET` (fallback: derive from existing `AUTH`/`NEXTAUTH` secret only if already used elsewhere; prefer dedicated env)

**Interfaces:**
- Produces: `mintExportFileSig(packageId, fileName, storageKey, expUnix): string`
- Produces: `verifyExportFileSig(...): boolean`
- TTL helper: `exportExpiryUnix(ttlSec = 3600): number`

Canonical string: `${packageId}\n${fileName}\n${storageKey}\n${expUnix}` HMAC-SHA256 hex.

- [ ] **Step 1: Failing round-trip + expiry tests**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Commit**

```powershell
git commit -m "feat(deploy): HMAC signing for package export file URLs`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: PS1 generator (deterministic)

**Files:**
- Create: `web/src/lib/software-export-script.ts`
- Create: `web/src/lib/software-export-script.test.ts`

**Interfaces:**
- Produces: `buildExportPs1(opts: { packageName, version, baseUrl, steps, files: { fileName, url, sha256 }[], aiComments?: string }): string`

Generator rules:
- `#Requires -RunAsAdministrator`
- `$WorkDir = Join-Path $env:TEMP ("h2tecs-export-" + [guid]::NewGuid())`
- For each file: `Invoke-WebRequest -Uri $url -OutFile (Join-Path $WorkDir $fileName)` then optional sha256 check
- For each step: if skipIf, embed Uninstall probe; if script, write `.ps1` and `&`; if install, run with silentArgs replacing `%DIR%`
- Exit 1 on hard failure

- [ ] **Step 1: Test — script contains package name, file URLs, skipIf displayName, %DIR% replaced concept**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Commit**

```powershell
git commit -m "feat(deploy): deterministic break-glass PowerShell generator`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Export API routes + UI button

**Files:**
- Create: `web/src/app/api/software/packages/[id]/export/route.ts` — GET, cookie + `software:deploy`, returns `text/plain` attachment `.ps1` (mint URLs with `WEB_PUBLIC_URL` or request origin)
- Create: `web/src/app/api/software/packages/[id]/export-file/route.ts` — GET, verify sig, stream `getObjectBytes`
- Modify: `web/src/components/software-library.tsx` — Export button → `window.location` or fetch blob download; optional “AI comments” checkbox calling existing Spec 34 assist if available (wrap in try/catch; on failure export without comments)

**Optional AI:** If assist API exists for freeform commentary, pass step summary; prepend as `#` comments. If not wired yet, ship checkbox disabled with tooltip “AI not configured”.

- [ ] **Step 1: Route tests or thin integration tests for 401 / bad sig / 200**
- [ ] **Step 2: Implement routes + button**
- [ ] **Step 3: Commit**

```powershell
git commit -m "feat(deploy): export install script and signed file downloads`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Docs — mark polish shipped

**Files:**
- Modify: `PROGRESS.md`
- Modify: `docs/specs/23-software-deployment/index.md` Follow-up
- Modify: design doc status → Implemented (when all slices merged)

- [ ] **Step 1: Update docs**
- [ ] **Step 2: Final PR(s)**

---

## Spec coverage check

| Spec item | Task |
|---|---|
| skipIf product_installed | 1–3 |
| timeoutSec + timed_out + kill | 2–3 |
| skipped reason cascade vs product_installed | 2–3 |
| Templates NetFx / Chrome+Edge / InstallShield | 5 |
| Export PS1 deterministic | 7–8 |
| Signed export-file URLs | 6, 8 |
| Optional AI comments | 8 |
| Non-goals respected | Global constraints |

## Placeholder scan

No TBD/TODO left in task steps; HMAC canonical string and default TTL specified.
