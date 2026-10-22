# Spec 31 v2 — Fleet OS multi-install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-select computers on `/patches` and enqueue OS-missing `patch_install_jobs` per host, with a fleet-wide max concurrent install cap.

**Architecture:** Bulk server action loops existing `enqueuePatchInstall` after loading each host’s missing OS KBs (`apps: []`). `claimNextPatchInstall` refuses new claims when `claimed|running` count ≥ `PATCH_INSTALL_MAX_CONCURRENT`. UI adds checkboxes + confirm on `PatchesFleet`. No batch parent table; no reboot; no winget fleet; no WSUS.

**Tech Stack:** Next.js App Router server actions, Drizzle, Vitest, existing collector patch-install drain (unchanged).

**Spec:** [`docs/superpowers/specs/2026-10-22-spec-31-v2-fleet-os-install-design.md`](../specs/2026-10-22-spec-31-v2-fleet-os-install-design.md)

## Global Constraints

- OS missing updates only on fleet action (`apps: []`) — no winget in this slice
- No automatic reboot (confirm copy must say so)
- Soft one-in-flight per computer unchanged (`pending|claimed|running`)
- Global cap default **5** via `PATCH_INSTALL_MAX_CONCURRENT`
- Permission: `software:deploy`
- Tag cap per request: **100**
- Partial success: skip + summarize; never all-or-nothing
- Out of scope: reboot-when-done, WSUS, KB-centric push, batch parent, Spec 34 v2+
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell; quote `(app)` paths; user runs servers/tests unless asked
- Implement on branch `feat/spec-31-v2-fleet-os-install` (create from `main` before first code commit; this plan/docs branch may merge separately)

---

## File structure

| File | Role |
|---|---|
| `web/src/db/patch-install.ts` | `PATCH_INSTALL_MAX_CONCURRENT`; claim gate; `listMissingOsKbIds`; `enqueueFleetOsPatchInstalls` |
| `web/src/db/patch-install.test.ts` | Claim-at-cap + fleet enqueue tests |
| `web/src/app/(app)/patch-install-actions.ts` | `requestFleetOsPatchInstall` |
| `web/src/components/patches-fleet.tsx` | Checkboxes, Install OS updates, confirm, summary |
| `web/src/components/patches-fleet.test.tsx` | Selection + deploy gate + confirm copy |
| `web/src/app/(app)/patches/page.tsx` | Pass `canDeploy` into fleet |
| `web/.env.example` | Document `PATCH_INSTALL_MAX_CONCURRENT` |
| Parent spec / PROGRESS (optional small note) | Point at v2 slice |

---

### Task 1: Claim concurrency cap

**Files:**
- Modify: `web/src/db/patch-install.ts`
- Modify: `web/src/db/patch-install.test.ts`
- Modify: `web/.env.example`

**Interfaces:**
- Produces: `PATCH_INSTALL_MAX_CONCURRENT` (number, default 5); `claimNextPatchInstall` returns `null` when in-flight count ≥ max
- Consumes: existing `patchInstallJobs` statuses `claimed` | `running`

- [ ] **Step 1: Failing tests for claim cap**

Add to `patch-install.test.ts` (same `H` mock). Claim currently: reaper `update`, then `execute` claim, then `select` job. After this task, claim does a **count `select` before `execute`**.

```ts
describe("claimNextPatchInstall — fleet concurrency", () => {
  it("returns null when claimed|running count is at max", async () => {
    process.env.PATCH_INSTALL_MAX_CONCURRENT = "2";
    // count query → [{ n: 2 }]
    H.state.selects = [[{ n: 2 }]];
    expect(await claimNextPatchInstall("w1")).toBeNull();
    expect(H.executeMock).not.toHaveBeenCalled();
  });

  it("claims when under max", async () => {
    process.env.PATCH_INSTALL_MAX_CONCURRENT = "2";
    H.state.selects = [
      [{ n: 1 }],
      [
        {
          id: JID,
          assetTag: "PC-1",
          targetIp: "192.168.70.5",
          selection: SEL,
          claimedAt: new Date("2026-10-19T10:00:00.000Z"),
        },
      ],
    ];
    H.state.execResult = [{ id: JID }];
    expect(await claimNextPatchInstall("w1")).toMatchObject({ id: JID });
  });
});
```

Clear/reset `PATCH_INSTALL_MAX_CONCURRENT` in `beforeEach` so other claim tests stay default.

Update the existing “returns the claimed job” test: push a count row first, e.g. `H.state.selects = [[{ n: 0 }], [jobRow]]`.

- [ ] **Step 2: Run tests — expect FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/db/patch-install.test.ts
```

Expected: new tests fail (count gate missing / select order wrong).

- [ ] **Step 3: Implement cap**

In `patch-install.ts`:

```ts
export const PATCH_INSTALL_MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.PATCH_INSTALL_MAX_CONCURRENT ?? 5),
);
```

At start of `claimNextPatchInstall`, after (or before) stuck reaper — **before** the claim `execute`:

```ts
const [countRow] = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(patchInstallJobs)
  .where(inArray(patchInstallJobs.status, ["claimed", "running"]));
if ((countRow?.n ?? 0) >= PATCH_INSTALL_MAX_CONCURRENT) {
  return null;
}
```

Do **not** count `pending` toward the cap.

- [ ] **Step 4: Document env**

In `web/.env.example` add:

```
# Spec 31 v2 — max simultaneous patch installs (claimed|running) fleet-wide
# PATCH_INSTALL_MAX_CONCURRENT=5
```

- [ ] **Step 5: Run tests — expect PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/db/patch-install.test.ts
```

- [ ] **Step 6: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git checkout -b feat/spec-31-v2-fleet-os-install main
# if already on feature branch, skip
git add web/src/db/patch-install.ts web/src/db/patch-install.test.ts web/.env.example
git commit -m @"
feat(spec 31): cap concurrent patch-install claims fleet-wide

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: Fleet enqueue helper + server action

**Files:**
- Modify: `web/src/db/patch-install.ts`
- Modify: `web/src/db/patch-install.test.ts`
- Modify: `web/src/app/(app)/patch-install-actions.ts`

**Interfaces:**
- Produces:
  - `listMissingOsKbIds(assetId: string): Promise<string[]>`
  - `enqueueFleetOsPatchInstalls(input: { tags: string[]; requestedBy: string }): Promise<{ enqueued: string[]; skipped: { tag: string; reason: "no-ip" | "no-missing" | "already-inflight" | "not-found" }[] }>`
  - `requestFleetOsPatchInstall({ assetTags: string[] })` action result union
- Consumes: `resolveDeployTarget`, `buildPatchSelection`, `enqueuePatchInstall`

- [ ] **Step 1: Failing tests**

```ts
describe("enqueueFleetOsPatchInstalls", () => {
  it("enqueues OS-only jobs and skips empty / no-ip / in-flight", async () => {
    // Mock resolveDeployTarget via vi.mock on software-deploy or spy:
    // tag A → { assetId, ip }; tag B → null; tag C → asset + ip but already inflight
    // For A: missing kb select returns [{ kbId: "KB1" }]; build/enqueue succeed
    // Assert enqueued length 1, skipped reasons include no-ip / already-inflight / no-missing
  });

  it("returns empty enqueued when tags empty", async () => {
    expect(
      await enqueueFleetOsPatchInstalls({ tags: [], requestedBy: "a@x.com" }),
    ).toEqual({ enqueued: [], skipped: [] });
  });
});
```

Prefer testing the DB helper with mocked `db` + mocked `resolveDeployTarget` (`vi.mock("@/db/software-deploy", ...)` if not already). Keep tests deterministic: do not hit real Postgres.

Also add a thin action test only if the repo already tests other actions the same way; otherwise cover permission/cap in a focused unit of the helper and exercise the action manually in Task 3 UI tests via mock.

- [ ] **Step 2: Run — expect FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/db/patch-install.test.ts
```

- [ ] **Step 3: Implement helpers**

```ts
export const FLEET_OS_INSTALL_TAG_CAP = 100;

export async function listMissingOsKbIds(assetId: string): Promise<string[]> {
  const rows = await db
    .select({ kbId: windowsMissingUpdates.kbId })
    .from(windowsMissingUpdates)
    .where(eq(windowsMissingUpdates.assetId, assetId));
  return rows.map((r) => r.kbId);
}

export type FleetOsSkipReason =
  | "no-ip"
  | "no-missing"
  | "already-inflight"
  | "not-found";

export async function enqueueFleetOsPatchInstalls(input: {
  tags: string[];
  requestedBy: string;
}): Promise<{
  enqueued: string[];
  skipped: { tag: string; reason: FleetOsSkipReason }[];
}> {
  const enqueued: string[] = [];
  const skipped: { tag: string; reason: FleetOsSkipReason }[] = [];
  const seen = new Set<string>();

  for (const raw of input.tags) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);

    const target = await resolveDeployTarget(tag);
    if (!target) {
      skipped.push({ tag, reason: "no-ip" }); // resolveDeployTarget null = missing computer or no IP
      continue;
    }

    const kbIds = await listMissingOsKbIds(target.assetId);
    if (kbIds.length === 0) {
      skipped.push({ tag, reason: "no-missing" });
      continue;
    }

    const built = await buildPatchSelection(target.assetId, kbIds, []);
    if (!built.ok) {
      skipped.push({ tag, reason: "no-missing" });
      continue;
    }

    const enq = await enqueuePatchInstall({
      assetId: target.assetId,
      targetIp: target.ip,
      selection: built.selection,
      requestedBy: input.requestedBy,
    });
    if (!enq.ok) {
      skipped.push({ tag, reason: "already-inflight" });
      continue;
    }
    enqueued.push(enq.id);
  }

  return { enqueued, skipped };
}
```

If `resolveDeployTarget` cannot distinguish not-found vs no-IP, map both to `no-ip` (spec allows that skip reason) **or** extend the helper to return `{ reason }` — prefer matching existing single-host copy (“needs an IP”) without a schema change.

- [ ] **Step 4: Server action**

In `patch-install-actions.ts`:

```ts
export async function requestFleetOsPatchInstall(input: {
  assetTags: string[];
}): Promise<
  | { ok: true; enqueued: string[]; skipped: { tag: string; reason: string }[] }
  | ActionErr
> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const tags = (input.assetTags ?? []).map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) {
    return { ok: false, error: "Select at least one computer.", code: "badrequest" };
  }
  if (tags.length > FLEET_OS_INSTALL_TAG_CAP) {
    return {
      ok: false,
      error: `Select at most ${FLEET_OS_INSTALL_TAG_CAP} computers.`,
      code: "badrequest",
    };
  }

  const result = await enqueueFleetOsPatchInstalls({
    tags,
    requestedBy: user.email,
  });
  revalidatePath("/patches");
  return { ok: true, ...result };
}
```

Import `FLEET_OS_INSTALL_TAG_CAP` and `enqueueFleetOsPatchInstalls` from `@/db/patch-install`.

- [ ] **Step 5: Run tests — PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/db/patch-install.test.ts
```

- [ ] **Step 6: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add "web/src/db/patch-install.ts" "web/src/db/patch-install.test.ts" "web/src/app/(app)/patch-install-actions.ts"
git commit -m @"
feat(spec 31): enqueue fleet OS patch installs from selected tags

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: `/patches` multi-select UI

**Files:**
- Modify: `web/src/components/patches-fleet.tsx`
- Modify: `web/src/components/patches-fleet.test.tsx`
- Modify: `web/src/app/(app)/patches/page.tsx`

**Interfaces:**
- Consumes: `requestFleetOsPatchInstall`
- Produces: `PatchesFleet({ rows, canDeploy }: { rows: FleetPatchRow[]; canDeploy: boolean })`

- [ ] **Step 1: Failing UI tests**

Extend `patches-fleet.test.tsx`:

```ts
it("hides Install OS updates without canDeploy", () => { /* render canDeploy=false; no button */ });
it("disables Install when nothing selected", () => { /* canDeploy true; button disabled */ });
it("confirm copy mentions OS updates and no reboot", async () => {
  // select a row, open dialog, assert text includes "not" / "reboot" and "OS"
});
```

Mock `@/app/(app)/patch-install-actions` like `updates-panel.test.tsx`.

- [ ] **Step 2: Run — expect FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/components/patches-fleet.test.tsx
```

- [ ] **Step 3: Wire page**

```tsx
<PatchesFleet
  rows={rows}
  canDeploy={hasPermission(user, "software:deploy")}
/>
```

- [ ] **Step 4: Implement UI**

In `PatchesFleet`:

- State: `selected: Set<string>` (asset tags); `confirmOpen`; `busy`; `summary` string | null.
- Header checkbox: select/deselect all tags in current `view`.
- Row checkbox (stop propagation so Link still works).
- Toolbar: when `canDeploy`, show **Install OS updates** disabled if `selected.size === 0` or `busy`.
- Dialog (same Dialog primitives as `updates-panel.tsx`):

```tsx
<DialogTitle>Install OS updates on {selected.size} computer{selected.size === 1 ? "" : "s"}?</DialogTitle>
<DialogDescription>
  Each selected computer will get all of its currently missing OS updates
  over WinRM. Hosts will <strong>not</strong> be rebooted automatically.
  Installs run with a fleet concurrency limit.
</DialogDescription>
```

- On confirm: `requestFleetOsPatchInstall({ assetTags: [...selected] })`; set summary from enqueued/skipped; clear selection on success; close dialog.

ColSpan for empty row: bump for new checkbox column (9).

- [ ] **Step 5: Run tests — PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npx vitest run src/components/patches-fleet.test.tsx src/db/patch-install.test.ts
```

- [ ] **Step 6: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add "web/src/components/patches-fleet.tsx" "web/src/components/patches-fleet.test.tsx" "web/src/app/(app)/patches/page.tsx"
git commit -m @"
feat(spec 31): multi-select Install OS updates on /patches

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: Docs closeout

**Files:**
- Modify: `docs/specs/31-patch-management/index.md` — short “v2 slice” note under Out of scope pointing at the design (fleet multi-install shipped / in progress)
- Modify: `PROGRESS.md` — when merging, add shipped entry (or 🚧 while on branch)
- Modify: design status line to Accepted once implementing

- [ ] **Step 1: Spec pointer**

Under “Out of scope / v2”, mark fleet multi-install as the first v2 slice with link to  
`docs/superpowers/specs/2026-10-22-spec-31-v2-fleet-os-install-design.md`. Leave reboot / WSUS deferred.

- [ ] **Step 2: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add docs/specs/31-patch-management/index.md docs/superpowers/specs/2026-10-22-spec-31-v2-fleet-os-install-design.md PROGRESS.md
git commit -m @"
docs(spec 31): note fleet OS multi-install v2 slice

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

- [ ] **Step 3: Manual smoke (user)**

1. Set `PATCH_INSTALL_MAX_CONCURRENT=2` in `web/.env`; restart web + worker.
2. Open `/patches` as deploy-capable user; select 3 hosts with missing OS; Install OS updates.
3. Confirm 3 jobs pending; at most 2 `claimed|running` at once.
4. Host without missing / without IP appears in skip summary.
5. Viewer without `software:deploy` sees no Install button.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Computer multi-select on `/patches` | 3 |
| OS-only all-missing enqueue | 2 |
| Reuse `patch_install_jobs` / worker | 2 (no collector change) |
| Global concurrency cap | 1 |
| Per-host one-in-flight | 2 (via `enqueuePatchInstall`) |
| Skip summary / partial success | 2–3 |
| `software:deploy` | 2–3 |
| Tag cap 100 | 2 |
| No reboot / no winget / no WSUS / no batch | Global constraints + Task 3 copy |
| `.env.example` | 1 |

No TBD placeholders. Types (`FleetOsSkipReason`, action result) consistent across Tasks 2–3.
