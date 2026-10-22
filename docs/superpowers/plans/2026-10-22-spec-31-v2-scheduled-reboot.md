# Spec 31 v2 — Scheduled reboot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins schedule forced reboots at a date+time (standalone or linked to patch install); collector WinRM-reboots when due; late successful install → ASAP; install fail/cancel → auto-cancel linked reboot.

**Architecture:** New `reboot_jobs` table + claim/status APIs mirroring patch-install. Link via `sourcePatchInstallJobId`. Worker drains due jobs with `Restart-Computer -Force`. UI datetime on Updates + optional “Also reboot at…” on install/fleet confirms.

**Tech Stack:** Next.js server actions, Drizzle/Postgres, Vitest, collector WinRM + pytest.

**Spec:** [`docs/superpowers/specs/2026-10-22-spec-31-v2-scheduled-reboot-design.md`](../specs/2026-10-22-spec-31-v2-scheduled-reboot-design.md)

## Global Constraints

- Surfaces: install-linked **and** standalone
- Schedule: exact date+time; store UTC; UI browser-local `datetime-local`
- Reject past `scheduledAt` at enqueue (~1 minute skew)
- Late install success → reboot ASAP; install fail/cancel → auto-cancel linked reboot
- Forced reboot only; no desktop countdown; no WSUS; no recurring
- Permission `software:deploy`; claim scope `deploy:agent`
- Soft one-in-flight reboot per computer (`pending|claimed|running`)
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell; quote `(app)` paths; user runs `npm run db:push`
- Implement on `feat/spec-31-v2-scheduled-reboot` (branch from `main`; docs may already be on `docs/spec-31-v2-scheduled-reboot` — merge/cherry-pick design+plan onto feature branch)

---

## File structure

| File | Role |
|---|---|
| `web/src/db/schema.ts` | `rebootJobs` table |
| `web/src/db/reboot.ts` (+ test) | enqueue, claim, cancel, status, sync on install terminal |
| `web/src/db/notifications.ts` (+ test) | `notifyRebootResult` |
| `web/src/app/api/reboot/claim/route.ts` (+ test) | service claim |
| `web/src/app/api/reboot/[id]/status/route.ts` (+ test) | fenced status |
| `web/src/app/(app)/reboot-actions.ts` | cookie schedule/cancel |
| `web/src/app/(app)/patch-install-actions.ts` | optional `rebootAtIso` |
| `web/src/db/patch-install.ts` | call sync on terminal status |
| `web/src/components/updates-panel.tsx` (+ test) | Schedule reboot + also-reboot on install |
| `web/src/components/patches-fleet.tsx` (+ test) | Also-reboot on fleet confirm |
| `collector/reboot.py` (+ test) | WinRM forced reboot |
| `collector/worker.py` | `_drain_reboot` |
| Spec 31 index / PROGRESS / design status | Docs |

---

### Task 1: Schema + reboot queue helpers

**Files:**
- Modify: `web/src/db/schema.ts` (after `patchInstallJobs`)
- Create: `web/src/db/reboot.ts`
- Create: `web/src/db/reboot.test.ts`

**Interfaces:**
- Produces:
  - table `reboot_jobs`
  - `enqueueRebootJob(input: { assetId, targetIp, scheduledAt: Date, requestedBy, sourcePatchInstallJobId?: string | null }): Promise<{ ok: true; id: string } | { ok: false; reason: "already-inflight" | "past-schedule" }>`
  - `claimNextReboot(workerId: string): Promise<ClaimedReboot | null>`
  - `updateRebootStatus(id, fence, patch): Promise<"ok" | "stale" | "notfound">`
  - `cancelRebootJob(id: string): Promise<boolean>`
  - `syncLinkedRebootsForInstall(installJobId: string, installStatus: "succeeded" | "failed" | "canceled"): Promise<void>` — cancel linked on fail/cancel; no-op on succeeded (claim gate handles due)
  - `listRebootJobsForAssetTag(tag: string): Promise<...>` (for Updates history)
- Consumes: `assets`, `patchInstallJobs`, `db`, stuck-timeout env pattern from patch-install

- [ ] **Step 1: Add schema** (mirror patch-install indexes; FK to patch install `onDelete: "set null"`)

```ts
export const rebootJobs = pgTable(
  "reboot_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    targetIp: text("target_ip").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    sourcePatchInstallJobId: uuid("source_patch_install_job_id").references(
      () => patchInstallJobs.id,
      { onDelete: "set null" },
    ),
    status: text("status")
      .$type<
        "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled"
      >()
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    workerId: text("worker_id"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("reboot_jobs_pending_due_idx")
      .on(t.status, t.scheduledAt)
      .where(sql`${t.status} = 'pending'`),
    index("reboot_jobs_inflight_idx")
      .on(t.assetId)
      .where(sql`${t.status} in ('pending','claimed','running')`),
    index("reboot_jobs_source_install_idx").on(t.sourcePatchInstallJobId),
  ],
);
```

- [ ] **Step 2: Failing tests** (mock `db` like `patch-install.test.ts`)

```ts
it("rejects scheduledAt in the past", async () => { /* past-schedule */ });
it("rejects second in-flight reboot for same asset", async () => { /* already-inflight */ });
it("claim returns null when scheduledAt in the future", async () => {});
it("claim returns null for linked job until install succeeded", async () => {});
it("claim returns job when due and standalone", async () => {});
it("claim returns linked job ASAP when install succeeded and scheduledAt past", async () => {});
it("syncLinkedRebootsForInstall cancels on failed", async () => {});
it("syncLinkedRebootsForInstall cancels on canceled", async () => {});
```

Claim SQL sketch: select pending where `scheduled_at <= now()`, and (`source_patch_install_job_id` is null OR linked install `status = 'succeeded'`), `FOR UPDATE SKIP LOCKED`, then set claimed. Reaper stuck claimed/running like patch-install (`REBOOT_STUCK_JOB_TIMEOUT_MS`, default 10 min).

- [ ] **Step 3: Implement → PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/db/reboot.test.ts
```

- [ ] **Step 4: Commit** (note: user runs `npm run db:push`)

```powershell
cd D:\Code\aw\aw-inventory
git checkout -b feat/spec-31-v2-scheduled-reboot main
# cherry-pick/merge docs commits if needed
git add web/src/db/schema.ts web/src/db/reboot.ts web/src/db/reboot.test.ts
git commit -m @"
feat(spec 31): reboot_jobs schema and queue helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: Notify + API routes + cookie actions

**Files:**
- Modify: `web/src/db/notifications.ts`, `notifications.test.ts`
- Create: `web/src/app/api/reboot/claim/route.ts` (+ `.test.ts`)
- Create: `web/src/app/api/reboot/[id]/status/route.ts` (+ `.test.ts`)
- Create: `web/src/app/(app)/reboot-actions.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `requireService` / deploy scope pattern from `patch-install/claim`
- Produces: `notifyRebootResult`; `requestRebootSchedule`; `requestCancelReboot`

- [ ] **Step 1: Failing tests** for claim 401/204/200; status fence; notify audience (requester); action forbidden without deploy

Mirror `web/src/app/api/patch-install/claim/route.ts` and status route. Notification types: add `"reboot"` / `"reboot-failed"` to the existing notification type union in `web/src/lib/data.ts` (and ticket mapping if required — follow how `patch-install` was added).

- [ ] **Step 2: Implement notify twin of `notifyPatchInstallResult`**

```ts
export async function notifyRebootResult(job: {
  jobId: string;
  assetId: string;
  status: "succeeded" | "failed" | "canceled";
  requestedBy: string;
  scheduledAtIso: string;
}): Promise<void>
```

Call from `updateRebootStatus` on terminal (like patch-install).

- [ ] **Step 3: Actions**

```ts
export async function requestRebootSchedule(input: {
  assetTag: string;
  scheduledAtIso: string;
}): Promise<ActionOk | ActionErr>

export async function requestCancelReboot(input: {
  id: string;
}): Promise<ActionOk | ActionErr>
```

Parse ISO → Date; reject invalid/past; `resolveDeployTarget`; `enqueueRebootJob` without source id.

- [ ] **Step 4: Tests PASS → Commit**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/db/reboot.test.ts src/db/notifications.test.ts src/app/api/reboot
```

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/notifications.ts web/src/db/notifications.test.ts web/src/lib/data.ts "web/src/app/api/reboot" "web/src/app/(app)/reboot-actions.ts"
git commit -m @"
feat(spec 31): reboot claim/status API and schedule actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Link patch-install lifecycle + optional rebootAt on enqueue

**Files:**
- Modify: `web/src/db/patch-install.ts` (`updatePatchInstallStatus` terminal → `syncLinkedRebootsForInstall`)
- Modify: `web/src/db/patch-install.test.ts`
- Modify: `web/src/app/(app)/patch-install-actions.ts`
- Modify: `web/src/db/reboot.ts` if helper `enqueueLinkedRebootForInstall(installId, ...)` needed

**Interfaces:**
- Produces: `requestPatchInstall({ ..., rebootAtIso?: string })`; `requestFleetOsPatchInstall({ ..., rebootAtIso?: string })`
- On each successful install enqueue with `rebootAtIso`, call `enqueueRebootJob({ ..., sourcePatchInstallJobId: installId })`

- [ ] **Step 1: Failing tests**

```ts
it("updatePatchInstallStatus failed cancels linked reboot", async () => {});
it("requestPatchInstall with rebootAtIso enqueues linked reboot", async () => {
  // unit-test DB helper path rather than full action if easier
});
```

- [ ] **Step 2: Implement sync hook in `updatePatchInstallStatus`** when status is `succeeded|failed|canceled` — call `syncLinkedRebootsForInstall`. For `succeeded`, sync is no-op (claim reads install status).

- [ ] **Step 3: Extend actions** — if `rebootAtIso` present, after install enqueue ok, enqueue linked reboot (same requestedBy/asset/ip). Fleet: for each enqueued install id, enqueue linked reboot with same datetime; collect reboot skip reasons into summary if needed (or best-effort log).

If linked reboot hits `already-inflight`, leave install enqueued and return warning in action result optional field `rebootWarning` — or fail soft (prefer soft: install ok, reboot skipped with reason in response).

- [ ] **Step 4: PASS → Commit**

```powershell
git add web/src/db/patch-install.ts web/src/db/patch-install.test.ts "web/src/app/(app)/patch-install-actions.ts" web/src/db/reboot.ts
git commit -m @"
feat(spec 31): link reboot jobs to patch-install lifecycle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: Collector WinRM reboot + worker drain

**Files:**
- Create: `collector/reboot.py`
- Create: `collector/tests/test_reboot.py`
- Modify: `collector/worker.py` (claim/status/drain next to patch-install; call from main loop)
- Modify: `collector/config.py` if timeout needed (`reboot_timeout` default 60)

**Interfaces:**
- Produces: `PS_REBOOT`, `run_reboot(config, job) -> (status, result)`
- Consumes: existing `_open_session`, `_run_ps_timeout`

- [ ] **Step 1: Failing test**

```python
def test_ps_reboot_is_forced():
    assert "Restart-Computer" in PS_REBOOT
    assert "-Force" in PS_REBOOT

def test_run_reboot_posts_success(monkeypatch):
    # session ok → status succeeded
```

- [ ] **Step 2: Implement**

```powershell
# PS_REBOOT
Restart-Computer -Force
```

Success = script ran without throw / exit 0. Host disappearing mid-call may look like transport error — treat connection-drop after send as success if that matches other ops; otherwise document: prefer `shutdown /r /t 0 /f` and accept exit. Keep simple: if WinRM returns before reboot completes, ok; if error contains connection reset after invoke, map to succeeded.

- [ ] **Step 3: Worker** — `_claim_reboot`, `_post_reboot_status`, `_drain_reboot` calling `/api/reboot/claim` and status. Invoke `_drain_reboot` in the same loop as `_drain_patch_install`.

- [ ] **Step 4: pytest PASS → Commit**

```powershell
cd D:\Code\aw\aw-inventory\collector
uv run pytest tests/test_reboot.py -q
```

```powershell
cd D:\Code\aw\aw-inventory
git add collector/reboot.py collector/tests/test_reboot.py collector/worker.py collector/config.py
git commit -m @"
feat(spec 31): collector drain for scheduled forced reboots

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 5: Updates + `/patches` UI

**Files:**
- Modify: `web/src/components/updates-panel.tsx` (+ test)
- Modify: `web/src/components/patches-fleet.tsx` (+ test)
- Modify: asset page data load if needed to pass reboot job list (`listRebootJobsForAssetTag`)

**Interfaces:**
- Consumes: `requestRebootSchedule`, `requestCancelReboot`, `requestPatchInstall`/`requestFleetOsPatchInstall` with `rebootAtIso`

- [ ] **Step 1: Failing UI tests**

```ts
it("shows Schedule reboot when canDeploy", () => {});
it("requires datetime for Schedule reboot", () => {});
it("install confirm Also reboot requires datetime", () => {});
it("fleet confirm passes rebootAtIso when checked", async () => {});
```

- [ ] **Step 2: Updates panel**

- Section: datetime-local + **Schedule reboot** button → `requestRebootSchedule`.  
- Install dialog: checkbox **Also reboot at…** + datetime; pass ISO to `requestPatchInstall`.  
- History list of reboot jobs + Cancel (pending/claimed).  
- Copy: forced reboot; late install → ASAP.

- [ ] **Step 3: Fleet confirm**

- Same checkbox + datetime; pass `rebootAtIso` into `requestFleetOsPatchInstall`.

Convert local `datetime-local` value to ISO via `new Date(value).toISOString()` (browser local interpretation).

- [ ] **Step 4: PASS → Commit**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/components/updates-panel.test.tsx src/components/patches-fleet.test.tsx
```

```powershell
git add web/src/components/updates-panel.tsx web/src/components/updates-panel.test.tsx web/src/components/patches-fleet.tsx web/src/components/patches-fleet.test.tsx "web/src/app/(app)/assets"
git commit -m @"
feat(spec 31): schedule reboot UI on Updates and fleet install

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 6: Docs closeout

**Files:**
- Modify: `docs/specs/31-patch-management/index.md` — v2 scheduled reboot slice + link  
- Modify: design status → Accepted  
- Modify: `PROGRESS.md` — 🚧 entry for branch  

- [ ] **Step 1: Docs + commit**

```powershell
git commit -m @"
docs(spec 31): note scheduled reboot v2 slice

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

- [ ] **Step 2: Manual smoke (user)** — `db:push`; schedule standalone future reboot; linked install with past-due time after quick install; cancel; fail install cancels reboot; confirm forced reboot on a lab host.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Standalone schedule date+time | 1–2, 5 |
| Install-linked + fleet | 3, 5 |
| Late install → ASAP | 1 claim gate |
| Fail/cancel → auto-cancel linked | 1 sync + 3 hook |
| Forced WinRM | 4 |
| Cancel / notify | 2 |
| `software:deploy` / `deploy:agent` | 2 |
| No WSUS / countdown / recurring | Global constraints |

No TBD placeholders. Types (`enqueueRebootJob` result, claim shape) consistent across tasks.
