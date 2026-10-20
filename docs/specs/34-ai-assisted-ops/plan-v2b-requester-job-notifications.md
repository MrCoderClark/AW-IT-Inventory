# Spec 34 v2b — Requester job notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retarget script / patch / deploy / printer-install completion notifications to the human requester (`audience=user`) when `requestedBy` looks like an email; keep admin broadcast for schedule/system jobs.

**Architecture:** Pure `resolveJobNotificationAudience(requestedBy)` decides audience. Existing `notify*` helpers accept `requestedBy` and pass audience fields into `createNotification`. Status updaters return `requestedBy` from the fenced update and forward it. Bell/SSE unchanged.

**Tech Stack:** Vitest, Drizzle status updaters, Spec 19 `createNotification` + audience columns (already on `main`).

**Design:** [design-v2b-requester-job-notifications.md](./design-v2b-requester-job-notifications.md)

## Global Constraints

- Branch from `main` as `feat/spec-34-v2b-requester-job-notifications` before application code (docs branch may already exist — rebase/merge or rename; never commit feature code on `main`).
- No schema / `db:push`. No collector / aw-auth changes.
- Requester-only for email `requestedBy`; non-email → `admins` (no dual-write).
- Do not change notification types, titles, bodies, hrefs, or dedupe keys except adding audience fields.
- `scan-failed` stays admin-only (out of scope).
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Shell is PowerShell; run vitest from `web/`.
- User runs servers / manual verify; agent provides commands.

---

## File map

| File | Responsibility |
|---|---|
| `web/src/lib/job-notification-audience.ts` | Pure resolver (email → user, else admins) |
| `web/src/lib/job-notification-audience.test.ts` | Resolver unit tests |
| `web/src/db/notifications.ts` | Thread `requestedBy` through four `notify*` helpers |
| `web/src/db/notifications.test.ts` | Assert audience on insert payloads |
| `web/src/db/script-runs.ts` | Pass `requestedBy` into `notifyScriptRunResult` |
| `web/src/db/patch-install.ts` | Pass `requestedBy` into `notifyPatchInstallResult` |
| `web/src/db/software-deploy.ts` | Pass `requestedBy` into `notifyDeployResult` |
| `web/src/db/printer-install.ts` | Pass `requestedBy` into `notifyInstallResult` |
| `web/src/db/patch-install.test.ts` | Expect `requestedBy` on notify mock |
| `web/src/db/software-deploy.test.ts` | Expect `requestedBy` on notify mock |
| `docs/specs/34-ai-assisted-ops/design-v2b-*.md` | Mark Accepted/shipped when done |
| `docs/specs/34-ai-assisted-ops/index.md` | Phase v2b status |

---

### Task 1: Audience resolver + notify helpers

**Files:**
- Create: `web/src/lib/job-notification-audience.ts`
- Create: `web/src/lib/job-notification-audience.test.ts`
- Modify: `web/src/db/notifications.ts` (`notifyInstallResult`, `notifyDeployResult`, `notifyPatchInstallResult`, `notifyScriptRunResult`)
- Modify: `web/src/db/notifications.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type JobNotificationAudience = {
    audience: "admins" | "user";
    recipientEmail: string | null;
  };
  export function resolveJobNotificationAudience(
    requestedBy: string,
  ): JobNotificationAudience;
  ```
- Consumes: existing `createNotification` / `NotificationAudience`

- [x] **Step 1: Write failing resolver tests**

Create `web/src/lib/job-notification-audience.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveJobNotificationAudience } from "./job-notification-audience";

describe("resolveJobNotificationAudience", () => {
  it("targets the requester when requestedBy looks like an email", () => {
    expect(resolveJobNotificationAudience("tech@opus.local")).toEqual({
      audience: "user",
      recipientEmail: "tech@opus.local",
    });
  });

  it("trims whitespace before checking", () => {
    expect(resolveJobNotificationAudience("  tech@opus.local  ")).toEqual({
      audience: "user",
      recipientEmail: "tech@opus.local",
    });
  });

  it("falls back to admins for schedule tokens", () => {
    expect(
      resolveJobNotificationAudience("schedule:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).toEqual({ audience: "admins", recipientEmail: null });
  });

  it("falls back to admins for empty / non-email strings", () => {
    expect(resolveJobNotificationAudience("")).toEqual({
      audience: "admins",
      recipientEmail: null,
    });
    expect(resolveJobNotificationAudience("worker-1")).toEqual({
      audience: "admins",
      recipientEmail: null,
    });
  });
});
```

- [x] **Step 2: Run resolver tests — expect FAIL**

```powershell
cd web; npx vitest run src/lib/job-notification-audience.test.ts --reporter=dot
```

Expected: FAIL (module not found / export missing).

- [x] **Step 3: Implement resolver**

Create `web/src/lib/job-notification-audience.ts`:

```ts
import type { NotificationAudience } from "@/lib/notification-visibility";

export type JobNotificationAudience = {
  audience: NotificationAudience;
  recipientEmail: string | null;
};

/** Spec 34 v2b: human email → requester-only; schedule/system → admin broadcast. */
export function resolveJobNotificationAudience(
  requestedBy: string,
): JobNotificationAudience {
  const trimmed = requestedBy.trim();
  if (trimmed.includes("@")) {
    return { audience: "user", recipientEmail: trimmed };
  }
  return { audience: "admins", recipientEmail: null };
}
```

- [x] **Step 4: Run resolver tests — expect PASS**

```powershell
cd web; npx vitest run src/lib/job-notification-audience.test.ts --reporter=dot
```

Expected: PASS.

- [x] **Step 5: Extend notify helper tests (failing on missing `requestedBy` / audience)**

In `web/src/db/notifications.test.ts`:

1. Import nothing new if asserting via `insertValues`.
2. Update every `notifyInstallResult({...})` call to include `requestedBy: "tech@opus.local"` (list-silent test too).
3. In the install-succeeded test, add to `toMatchObject`:
   ```ts
   audience: "user",
   recipientEmail: "tech@opus.local",
   ```
4. Add a new test after the install suite:

```ts
it("schedule requestedBy keeps admin audience", async () => {
  H.selectQueue.push(asset);
  H.insertReturning.push(createdRow("printer-install"));
  await notifyInstallResult({
    jobId: "j5",
    action: "install",
    status: "succeeded",
    assetId: "a1",
    printerName: "Canon iR",
    error: null,
    requestedBy: "schedule:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  const v = H.insertValues.at(-1) as Record<string, unknown>;
  expect(v).toMatchObject({
    audience: "admins",
    recipientEmail: null,
  });
});
```

5. Add parallel coverage for the other three helpers if they lack suites: at minimum one email + one schedule case each for `notifyScriptRunResult`, `notifyDeployResult`, `notifyPatchInstallResult` (same insertValues pattern; push one asset select + insertReturning per call). Import the three helpers next to `notifyInstallResult`.

Example for script (mirror for deploy/patch with their field names):

```ts
describe("notifyScriptRunResult audience", () => {
  const asset = [{ tag: "PC-1", name: "Reception PC" }];
  it("email → user", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push([
      {
        id: "n1",
        type: "script-run",
        severity: "info",
        title: "t",
        body: "b",
        href: "/assets/PC-1",
        assetId: "a1",
        createdAt: new Date("2026-10-06T12:00:00Z"),
      },
    ]);
    await notifyScriptRunResult({
      jobId: "s1",
      status: "succeeded",
      assetId: "a1",
      scriptName: "DiskCleanup",
      error: null,
      requestedBy: "tech@opus.local",
    });
    expect(H.insertValues.at(-1)).toMatchObject({
      audience: "user",
      recipientEmail: "tech@opus.local",
    });
  });
});
```

- [x] **Step 6: Run notifications tests — expect FAIL**

```powershell
cd web; npx vitest run src/db/notifications.test.ts --reporter=dot
```

Expected: FAIL (missing `requestedBy` / audience not set).

- [x] **Step 7: Update the four notify helpers**

In `web/src/db/notifications.ts`:

```ts
import { resolveJobNotificationAudience } from "@/lib/job-notification-audience";
```

Add `requestedBy: string` to each of:

- `notifyInstallResult`
- `notifyDeployResult`
- `notifyPatchInstallResult`
- `notifyScriptRunResult`

Immediately before each `createNotification({...})`:

```ts
const { audience, recipientEmail } = resolveJobNotificationAudience(job.requestedBy);
```

Spread into the create call:

```ts
await createNotification({
  // ...existing fields unchanged...
  audience,
  recipientEmail,
});
```

For `notifyInstallResult`, resolve after the `list` early-return (list stays silent and does not need audience).

- [x] **Step 8: Run notifications + resolver tests — expect PASS**

```powershell
cd web; npx vitest run src/lib/job-notification-audience.test.ts src/db/notifications.test.ts --reporter=dot
```

Expected: all PASS.

- [x] **Step 9: Commit**

```powershell
git add web/src/lib/job-notification-audience.ts web/src/lib/job-notification-audience.test.ts web/src/db/notifications.ts web/src/db/notifications.test.ts
git commit -m @"
feat(spec 34 v2b): resolve job notification audience for requester vs admins

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: Pass `requestedBy` from status updaters

**Files:**
- Modify: `web/src/db/script-runs.ts` (`updateScriptRunStatus` returning + notify call)
- Modify: `web/src/db/patch-install.ts` (`updatePatchInstallStatus`)
- Modify: `web/src/db/software-deploy.ts` (`updateDeploymentStatus`)
- Modify: `web/src/db/printer-install.ts` (`updateInstallJobStatus`)
- Modify: `web/src/db/patch-install.test.ts`
- Modify: `web/src/db/software-deploy.test.ts`

**Interfaces:**
- Consumes: `notify*(…, requestedBy: string)` from Task 1
- Produces: status updaters forward job row `requestedBy` unchanged

- [x] **Step 1: Update failing status-updater expectations**

In `web/src/db/patch-install.test.ts` “notifies on success”:

```ts
H.state.updateReturns = [
  [{ id: JID, assetId: "a1", selection: SEL, requestedBy: "me@x.com" }],
];
// ...
expect(H.notifyMock).toHaveBeenCalledWith(
  expect.objectContaining({
    jobId: JID,
    status: "succeeded",
    osCount: 1,
    appCount: 1,
    requestedBy: "me@x.com",
  }),
);
```

In `web/src/db/software-deploy.test.ts` “notifies on a successful finish”:

```ts
H.state.updateReturns = [
  [{ id: DID, assetId: "a1", snapshot: SNAP, requestedBy: "me@x.com" }],
];
// ...
expect(H.notifyMock).toHaveBeenCalledWith(
  expect.objectContaining({
    deploymentId: DID,
    status: "succeeded",
    packageName: "App",
    requestedBy: "me@x.com",
  }),
);
```

- [x] **Step 2: Run those two test files — expect FAIL**

```powershell
cd web; npx vitest run src/db/patch-install.test.ts src/db/software-deploy.test.ts --reporter=dot
```

Expected: FAIL (`requestedBy` missing on notify args).

- [x] **Step 3: Wire `requestedBy` in all four status updaters**

**script-runs.ts** — extend `.returning` and notify:

```ts
.returning({
  id: scriptRunJobs.id,
  assetId: scriptRunJobs.assetId,
  snapshot: scriptRunJobs.scriptSnapshot,
  requestedBy: scriptRunJobs.requestedBy,
});
// ...
await notifyScriptRunResult({
  jobId: row.id,
  status: u.status,
  assetId: row.assetId,
  scriptName: row.snapshot.name,
  error: u.error ?? null,
  requestedBy: row.requestedBy,
});
```

**patch-install.ts** — same pattern with `patchInstallJobs.requestedBy` → `notifyPatchInstallResult`.

**software-deploy.ts** — `softwareDeployments.requestedBy` → `notifyDeployResult`.

**printer-install.ts** — `printerInstallJobs.requestedBy` → `notifyInstallResult`.

- [x] **Step 4: Run related tests — expect PASS**

```powershell
cd web; npx vitest run src/db/notifications.test.ts src/db/patch-install.test.ts src/db/software-deploy.test.ts src/db/script-runs.test.ts src/lib/job-notification-audience.test.ts --reporter=dot
```

Expected: all PASS. (Typecheck: if `script-runs` / printer compile errors surface in IDE, fix before commit.)

- [x] **Step 5: Commit**

```powershell
git add web/src/db/script-runs.ts web/src/db/patch-install.ts web/src/db/software-deploy.ts web/src/db/printer-install.ts web/src/db/patch-install.test.ts web/src/db/software-deploy.test.ts
git commit -m @"
feat(spec 34 v2b): pass requestedBy into job completion notifications

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Docs + ship checklist

**Files:**
- Modify: `docs/specs/34-ai-assisted-ops/design-v2b-requester-job-notifications.md` (Status → Accepted / shipped)
- Modify: `docs/specs/34-ai-assisted-ops/index.md` (v2b phase line → shipped)
- Modify: `docs/specs/34-ai-assisted-ops/plan-v2b-requester-job-notifications.md` (checkboxes as completed when executing)

- [x] **Step 1: Mark design + index shipped**

Design header:

```md
**Status**: Accepted (shipped on `main`) — [plan](./plan-v2b-requester-job-notifications.md)
```

Index phase 3:

```md
3. **v2b** — [requester notifications for worker jobs](./design-v2b-requester-job-notifications.md)
   ([plan](./plan-v2b-requester-job-notifications.md)): shipped — script / patch /
   deploy / printer-install completion bells target the requester; schedule/system
   `requestedBy` stays admin broadcast.
```

- [x] **Step 2: Commit docs**

```powershell
git add docs/specs/34-ai-assisted-ops/
git commit -m @"
docs(spec 34): mark v2b requester job notifications shipped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

- [ ] **Step 3: Manual verify (user)**

1. Non-admin tech runs a script → only that user gets toast/bell.  
2. Another admin does not see that completion.  
3. Schedule-fired script still notifies admins.

---

## Spec coverage (self-review)

| AC | Task |
|---|---|
| AC-F1 email → user | Task 1 + 2 |
| AC-F2 schedule → admins | Task 1 |
| AC-F3 types/copy/dedupe unchanged | Task 1 (only audience fields added) |
| AC-F4 success + fail still notify | unchanged call sites; Task 2 only adds field |
| AC-F5 unit tests | Task 1–2 |

No placeholders. Resolver heuristic matches design (`includes("@")` after trim).
