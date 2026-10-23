# Computer audit log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unified computer action log (`computer_audit_events`) with dual-write from job paths, `/audit` UI matching the mock, and Spec 26 report source `computerAuditEvents`.

**Architecture:** Append/upsert one row per originating job (`source_table` + `source_id` unique). Enqueue → `pending`; terminal → enrich `summary`/`details` + status. Best-effort writes must not fail primary jobs. Forward-only from ship day.

**Tech Stack:** Next.js App Router, Drizzle/Postgres, Spec 26 report catalog, Vitest (user runs), existing `audit:read` permission.

**Spec:** [`docs/superpowers/specs/2026-10-23-computer-audit-log-design.md`](../specs/2026-10-23-computer-audit-log-design.md)  
**Mock:** [`docs/Design/computer-audit-log-mock.png`](../../Design/computer-audit-log-mock.png)

## Global Constraints

- Computers only; admin + scheduled/automated jobs; no scan/metrics poll noise
- One mutable row per job: `pending` → `succeeded` | `failed` | `canceled`
- Forward-only (no historical backfill)
- Dual-write helpers; catch-and-log so audit never blocks the job
- Unique `(source_table, source_id)`; `occurred_at` stable on status updates
- Gate `/audit` + report source with `audit:read`
- CSV export on `/audit`; PDF via Spec 26 only in v1
- Agents: **do not run Vitest** (`npm test` / `npx vitest`) — write tests, give the user the exact command
- User runs `npm run db:push` after schema lands
- Branch: implement on `feat/computer-audit-log` from `main` (merge/cherry-pick this docs branch first)
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell; quote paths containing `(app)`

---

## File structure

| File | Role |
|---|---|
| `web/src/db/schema.ts` | `computerAuditEvents` table |
| `web/src/db/computer-audit.ts` (+ test) | upsert / updateStatus / list / KPIs / CSV rows |
| `web/src/lib/computer-audit-actions.ts` | Action code constants + summary formatters |
| Job modules (deploy, patch, reboot, scripts, remote, assignments, asset update) | Dual-write call sites |
| `web/src/app/(app)/audit/page.tsx` | Server page |
| `web/src/components/audit-log-view.tsx` (+ test) | Filters, KPIs, table, CSV |
| `web/src/lib/data.ts` + sidebar tests | Nav item `Audit log` → `/audit`, `perm: "audit:read"` |
| `web/src/lib/report-sources.ts` + `web/src/db/report-engine.ts` (+ tests) | `computerAuditEvents` source |
| `PROGRESS.md` + spec status | Docs |

---

### Task 1: Schema + action constants

**Files:**
- Modify: `web/src/db/schema.ts` (place near other job tables; after `rebootSchedules` / before thin tables is fine)
- Create: `web/src/lib/computer-audit-actions.ts`
- Create: `web/src/lib/computer-audit-actions.test.ts`

**Interfaces:**
- Produces:
  - Table `computer_audit_events` / export `computerAuditEvents`
  - `export const AUDIT_ACTIONS = [ ... ] as const` and `export type AuditAction = typeof AUDIT_ACTIONS[number]`
  - `export type AuditStatus = "pending" | "succeeded" | "failed" | "canceled"`
  - `export type AuditSource = "admin_console" | "scheduled" | "collector"`
  - `export function formatAppUpgradeSummary(name: string, from: string | null, to: string | null): string` → e.g. `Updated Chrome 128.0 → 129.0` or `Updated Chrome → 129.0` when from missing
  - `export function formatInstallSummary(name: string, version: string | null): string` → `Installed VLC 3.0.20` / `Installed VLC`

- [ ] **Step 1: Add table to schema**

```ts
export const computerAuditEvents = pgTable(
  "computer_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    status: text("status").notNull().default("pending"),
    operator: text("operator").notNull(),
    source: text("source").notNull(),
    summary: text("summary").notNull().default(""),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    sourceTable: text("source_table").notNull(),
    sourceId: uuid("source_id").notNull(),
    flagged: boolean("flagged").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("computer_audit_events_source_uidx").on(t.sourceTable, t.sourceId),
    index("computer_audit_events_occurred_idx").on(t.occurredAt),
    index("computer_audit_events_asset_occurred_idx").on(t.assetId, t.occurredAt),
    index("computer_audit_events_action_idx").on(t.action),
    index("computer_audit_events_operator_idx").on(t.operator),
    index("computer_audit_events_flagged_idx").on(t.flagged),
  ],
);
export type ComputerAuditEventRow = typeof computerAuditEvents.$inferSelect;
```

- [ ] **Step 2: Action helpers + failing tests**

```ts
// web/src/lib/computer-audit-actions.test.ts
import { describe, it, expect } from "vitest";
import { formatAppUpgradeSummary, formatInstallSummary } from "./computer-audit-actions";

describe("formatInstallSummary", () => {
  it("includes version when present", () => {
    expect(formatInstallSummary("VLC", "3.0.20")).toBe("Installed VLC 3.0.20");
  });
  it("omits version when null", () => {
    expect(formatInstallSummary("VLC", null)).toBe("Installed VLC");
  });
});

describe("formatAppUpgradeSummary", () => {
  it("shows from → to", () => {
    expect(formatAppUpgradeSummary("Chrome", "128.0", "129.0")).toBe(
      "Updated Chrome 128.0 → 129.0",
    );
  });
});
```

- [ ] **Step 3: Implement helpers** (constants + formatters as above)

- [ ] **Step 4: User runs tests**

```powershell
cd web; npx vitest run src/lib/computer-audit-actions.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add web/src/db/schema.ts web/src/lib/computer-audit-actions.ts web/src/lib/computer-audit-actions.test.ts
git commit -m "feat(audit): computer_audit_events schema + summary helpers`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Remind user: `cd web; npm run db:push`

---

### Task 2: Audit write/read API

**Files:**
- Create: `web/src/db/computer-audit.ts`
- Create: `web/src/db/computer-audit.test.ts`

**Interfaces:**
- Consumes: `computerAuditEvents`, action types from Task 1
- Produces:
  - `upsertAuditEvent(input: { sourceTable: string; sourceId: string; assetId: string; action: AuditAction; operator: string; source: AuditSource; summary: string; details?: Record<string, unknown>; status?: AuditStatus; occurredAt?: Date }): Promise<{ ok: true; id: string } | { ok: false }>`
  - On conflict `(sourceTable, sourceId)`: update mutable fields **except** `occurredAt` (keep first); set `updatedAt`
  - `updateAuditEventStatus(input: { sourceTable: string; sourceId: string; status: AuditStatus; summary?: string; details?: Record<string, unknown> }): Promise<boolean>`
  - Both wrap DB work in try/catch → log `console.error("[audit]", …)` and return `{ ok: false }` / `false` (never throw)
  - `listAuditEvents(filters: { assetId?: string; action?: string; operator?: string; locationId?: string; from?: Date; to?: Date; flagged?: boolean; limit?: number; offset?: number }): Promise<AuditListItem[]>`
  - `AuditListItem`: `{ id, occurredAtIso, assetTag, assetName, serial, action, status, operator, source, summary, flagged, details }`
  - `getAuditKpis(filters: same time/location subset): Promise<{ total, today, uniqueOperators, flagged }>`
  - Join `assets` (+ location when filtering). Default `from` = now − 30 days when listing for the page.

- [ ] **Step 1: Failing tests** (mock `db` the same way as `web/src/db/reboot.test.ts` / `reboot-schedules.test.ts` — copy that harness pattern)

Cover at least:
1. `upsertAuditEvent` inserts values including `sourceTable`/`sourceId`
2. conflict path does not overwrite `occurredAt` in the `set` clause (assert update payload)
3. `updateAuditEventStatus` returns false when catch fires / no row
4. upsert catch returns `{ ok: false }` without throwing

- [ ] **Step 2: Implement `computer-audit.ts`**

Use Drizzle `insert().values().onConflictDoUpdate({ target: [computerAuditEvents.sourceTable, computerAuditEvents.sourceId], set: { … } })`.

- [ ] **Step 3: User runs**

```powershell
cd web; npx vitest run src/db/computer-audit.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add web/src/db/computer-audit.ts web/src/db/computer-audit.test.ts
git commit -m "feat(audit): upsert/update/list/KPI helpers`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Instrument software deploy (+ app upgrade path)

**Files:**
- Modify: `web/src/db/software-deploy.ts` — after successful insert in `enqueueDeployment`; in `updateDeploymentStatus` / `cancelDeployment` on terminal
- Modify: `web/src/db/patch-install.ts` — enqueue + terminal for OS/app items (use `app_upgrade` when result/item is an app upgrade with versions; else `os_patch_install` / keep one row per **job** not per KB — summary can list count or primary package)
- Tests: extend existing `software-deploy` / `patch-install` unit tests with audit mocks (vi.mock `@/db/computer-audit`)

**Interfaces:**
- Consumes: `upsertAuditEvent`, `updateAuditEventStatus`, formatters
- `sourceTable`: `"software_deployments"` / `"patch_install_jobs"`
- Deploy enqueue: `action: "software_deploy"`, `source: "admin_console"`, `operator: requestedBy`, `summary: formatInstallSummary(snapshot.name, snapshot.version)`, `details: { packageId, packageName, version }`
- Deploy terminal: map job status → audit status; on success refresh summary if result has version
- Patch install: one audit row per job; `details` may include `osKbIds`, `appUpgrades: [{ id, from, to }]` when available at terminal; if single app upgrade, prefer `formatAppUpgradeSummary`

- [ ] **Step 1: Mock + assert upsert called from enqueueDeployment test**

- [ ] **Step 2: Wire enqueue + terminal/cancel**

Pattern after job insert succeeds:

```ts
void upsertAuditEvent({
  sourceTable: "software_deployments",
  sourceId: row.id,
  assetId: input.assetId,
  action: "software_deploy",
  operator: input.requestedBy,
  source: "admin_console",
  summary: formatInstallSummary(
    input.packageSnapshot.name,
    input.packageSnapshot.version ?? null,
  ),
  details: {
    packageId: input.packageId,
    packageName: input.packageSnapshot.name,
    version: input.packageSnapshot.version ?? null,
  },
  status: "pending",
});
```

Use `void` or await-inside-try in helper (helper already catches). Prefer **await helper after** the job commit so the job id exists; do not wrap the job insert in the same try as audit if that risks rollback — call audit **after** successful returning.

- [ ] **Step 3: Same for patch-install enqueue/terminal**

- [ ] **Step 4: User runs relevant tests**

```powershell
cd web; npx vitest run src/db/computer-audit.test.ts src/db/software-deploy.test.ts src/db/patch-install.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add web/src/db/software-deploy.ts web/src/db/patch-install.ts
git commit -m "feat(audit): dual-write deploy and patch-install jobs`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Instrument reboot, scripts, remote, assignment, asset update

**Files:**
- Modify: `web/src/db/reboot.ts` — `enqueueRebootJob` + terminal/`cancelRebootJob`
- Modify: `web/src/db/reboot-schedules.ts` — upsert/enable/delete schedule → action `reboot_schedule` with `sourceTable: "reboot_schedules"` (admin); materialized jobs already covered via `reboot.ts` with `source: "scheduled"` when `sourceScheduleId` set
- Modify: script run enqueue/status module (find `script_run_jobs` writers under `web/src/db/` — typically `script-runs.ts` or similar)
- Modify: remote session create/end writers
- Modify: `web/src/db/assignments.ts` — after successful assign/return (use assignment row id as `sourceId` if available; else synthesize stable id carefully — prefer real `asset_assignments.id`)
- Modify: computer asset update path (server action / `queries` update) — only when Computer fields change; `sourceTable: "assets"`, `sourceId: asset.id`, action `asset_update` (upsert so repeated edits update same day row **or** insert new row per save — **prefer new row per successful save** with `sourceId` = a new uuid stored only in audit, OR use `sourceTable: "asset_updates"` + random uuid each save). Spec: one row per job; for CRUD use **one row per save** with unique `sourceId` (generate uuid at write time, only stored on audit row).

**Reboot source rule:** if `input.sourceScheduleId` present → `source: "scheduled"`, `operator: "system"` (or schedule `requestedBy` if easily loaded); else `admin_console` + `requestedBy`.

- [ ] **Step 1: Wire each call site with matching unit-test mocks**

- [ ] **Step 2: User runs**

```powershell
cd web; npx vitest run src/db/reboot.test.ts src/db/reboot-schedules.test.ts src/db/assignments.test.ts
```

(Add other files that exist for scripts/remote.)

- [ ] **Step 3: Commit**

```powershell
git commit -m "feat(audit): dual-write reboot, scripts, remote, custody, asset edits`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `/audit` page + nav

**Files:**
- Create: `web/src/app/(app)/audit/page.tsx`
- Create: `web/src/components/audit-log-view.tsx`
- Create: `web/src/components/audit-log-view.test.tsx`
- Modify: `web/src/lib/data.ts` — add to `NAV_MANAGE` (near Reports):

```ts
{ label: "Audit log", href: "/audit", icon: ScrollText, perm: "audit:read" },
```

(Import `ScrollText` from `lucide-react` alongside other icons in that file.)

- Modify: `web/src/components/app-sidebar.test.tsx` — expect Audit log visible when `audit:read` present, hidden otherwise

**Page:**
- `requireUser` + `hasPermission(..., "audit:read")` else placeholder forbidden
- Parse searchParams for filters (or client-side filter state with server load of last 30 days)
- Load `listAuditEvents` + `getAuditKpis`
- Render `HeroHeader` title `Audit log`, badge/subtitle `Activity`
- Pass data to `AuditLogView` with Export CSV button (client download of current filtered rows as CSV)

**UI columns:** match mock — Time, Asset (Link), Serial, Action chip, Operator, Source label, Status chip, Details (`summary`).

- [ ] **Step 1: Nav + permission test**

- [ ] **Step 2: Page + view component + component test** (render KPIs + a sample row; click Export if easy to assert)

- [ ] **Step 3: User runs**

```powershell
cd web; npx vitest run src/components/audit-log-view.test.tsx src/components/app-sidebar.test.tsx
```

- [ ] **Step 4: Commit**

```powershell
git add "web/src/app/(app)/audit" web/src/components/audit-log-view.tsx web/src/components/audit-log-view.test.tsx web/src/lib/data.ts web/src/components/app-sidebar.test.tsx
git commit -m "feat(audit): /audit page, nav, CSV export`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Spec 26 report source

**Files:**
- Modify: `web/src/lib/report-sources.ts` — add `computerAuditEvents` source + fields
- Modify: `web/src/db/report-engine.ts` — `computerAuditEventsSource` + register in `SOURCE_FETCHERS`
- Modify/create tests next to existing report-engine tests

**Fields (row keys must match):**  
`occurredAt`, `assetTag`, `assetName`, `serial`, `action`, `status`, `operator`, `source`, `summary`, `flagged`, `location` (optional)

Fetcher: query `computer_audit_events` ⨝ `assets` (location join like other sources), map ISO dates to strings, apply safe pushdown filters if the engine already does for dates/enums.

- [ ] **Step 1: Catalog + fetcher + test that `runReportBySpec` accepts the source**

- [ ] **Step 2: User runs report tests**

```powershell
cd web; npx vitest run src/db/report-engine.test.ts src/lib/report-sources.test.ts
```

(Adjust paths to whatever exists.)

- [ ] **Step 3: Commit**

```powershell
git commit -m "feat(audit): Spec 26 computerAuditEvents report source`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Docs

**Files:**
- Modify: `PROGRESS.md` — new 🚧 entry for computer audit log
- Modify: `docs/superpowers/specs/2026-10-23-computer-audit-log-design.md` — Status → Implemented on `feat/computer-audit-log`
- Optional one-liner in `docs/specs/00-overview-and-plan.md` if it still says audit is only aspirational

- [ ] **Step 1: Update docs + commit**

```powershell
git add PROGRESS.md docs/superpowers/specs/2026-10-23-computer-audit-log-design.md
git commit -m "docs(audit): note computer audit log implementation`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| `computer_audit_events` dual-write table | 1–2 |
| Rich install / version summaries | 1, 3 |
| Pending → terminal row | 2–4 |
| Admin + scheduled sources | 4 (reboot/scripts) |
| Computers only, forward-only | Global + all writers |
| `/audit` UI + CSV + `audit:read` | 5 |
| Spec 26 `computerAuditEvents` | 6 |
| Audit failure must not block jobs | 2 (catch-and-log) |
| No backfill / no scan noise | Global / omit scan writers |

## Placeholder scan

No TBD steps; Vitest is user-run; `db:push` is user-run.

## Type consistency

- `AuditAction` / `AuditStatus` / `AuditSource` defined in Task 1; used by Task 2+
- `sourceTable` strings: `software_deployments`, `patch_install_jobs`, `reboot_jobs`, `reboot_schedules`, `script_run_jobs` (confirm actual table name in schema), remote sessions table name from schema, `asset_assignments`, and per-save uuid for asset edits
- Report field ids align with `AuditListItem` mapping in Task 6
