# Spec 31 v2 — Recurring reboot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-computer daily/weekly recurring forced reboot that materializes one-shot `reboot_jobs`; skip missed windows; at most one schedule per asset.

**Architecture:** New `reboot_schedules` table + pure next-occurrence math (Luxon). Web upserts schedules and materializes the next pending `reboot_jobs` child (`source_schedule_id`). Collector only claims/executes jobs as today; a light worker POST (same pattern as script-schedules) runs `materializeDueRebootSchedules` so orphans get a child. Terminal schedule-sourced jobs rematerialize the following occurrence.

**Tech Stack:** Next.js server actions, Drizzle/Postgres, Luxon, Vitest, collector httpx tick + pytest.

**Spec:** [`docs/superpowers/specs/2026-10-23-spec-31-v2-recurring-reboot-design.md`](../specs/2026-10-23-spec-31-v2-recurring-reboot-design.md)

## Global Constraints

- Per-computer only; daily + weekly; skip missed slots (no catch-up)
- At most one schedule row per asset (upsert replaces)
- Store IANA `timezone` + local `HH:MM`; compute next UTC with Luxon
- Reuse `reboot_jobs` + existing collector drain; add `source_schedule_id`
- Soft one-in-flight per asset unchanged; materializer must not double-book
- Cancel occurrence ≠ disable series; disable/delete cancels pending child
- Permission `software:deploy`; tick API `deploy:agent`
- No fleet / install-linked recurrence / countdown / cron
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell; quote `(app)` paths; user runs `npm run db:push` and `npm install` for luxon
- Implement on `feat/spec-31-v2-recurring-reboot` branched from `main` (cherry-pick or merge this docs branch first)

---

## File structure

| File | Role |
|---|---|
| `web/package.json` | Add `luxon` + `@types/luxon` |
| `web/src/lib/reboot-occurrence.ts` (+ test) | Pure next UTC occurrence |
| `web/src/db/schema.ts` | `rebootSchedules`; `rebootJobs.sourceScheduleId` |
| `web/src/db/reboot-schedules.ts` (+ test) | upsert / enable / delete / materialize |
| `web/src/db/reboot.ts` | Pass `sourceScheduleId` into enqueue; rematerialize on terminal/cancel |
| `web/src/app/(app)/reboot-actions.ts` (+ test) | Cookie upsert/enable/delete |
| `web/src/app/api/reboot/schedules/due/route.ts` (+ test) | Service tick |
| `web/src/components/updates-panel.tsx` (+ test) | Recurring UI block |
| `web/src/app/(app)/assets/[id]/page.tsx` + `computer-detail.tsx` | Load/pass schedule |
| `collector/config.py` + `config.example.yaml` | `reboot_schedule_interval_minutes` |
| `collector/reachability.py` + `worker.py` (+ test) | POST due tick |
| Spec status / `PROGRESS.md` | Docs |

---

### Task 1: Luxon + next-occurrence helper

**Files:**
- Modify: `web/package.json` (user runs `npm install luxon` and `npm install -D @types/luxon` in `web/`)
- Create: `web/src/lib/reboot-occurrence.ts`
- Create: `web/src/lib/reboot-occurrence.test.ts`

**Interfaces:**
- Produces:
  - `export type RebootCadence = "daily" | "weekly"`
  - `export function nextRebootOccurrence(input: { cadence: RebootCadence; weekdays: number[] | null; localTime: string; timezone: string; now?: Date }): Date`
  - Weekdays: ISO `1=Mon … 7=Sun`. For `daily`, `weekdays` ignored. For `weekly`, require non-empty unique ints in 1..7.
  - `localTime`: `/^\d{2}:\d{2}$/` 24h. Return Date **strictly after** `now` (default `new Date()`).
  - DST: use Luxon `DateTime.fromObject` / `setZone`; if local time does not exist (spring forward), advance to the next valid clock time that day if possible, else next matching day — never return `<= now`.

- [ ] **Step 1: Add dependency**

```powershell
cd web; npm install luxon; npm install -D @types/luxon
```

- [ ] **Step 2: Write failing tests**

```ts
// web/src/lib/reboot-occurrence.test.ts
import { describe, it, expect } from "vitest";
import { nextRebootOccurrence } from "./reboot-occurrence";

describe("nextRebootOccurrence", () => {
  it("daily: later today", () => {
    const now = new Date("2026-10-23T14:00:00.000Z"); // 10:00 America/New_York (EDT)
    const next = nextRebootOccurrence({
      cadence: "daily",
      weekdays: null,
      localTime: "15:30",
      timezone: "America/New_York",
      now,
    });
    expect(next.toISOString()).toBe("2026-10-23T19:30:00.000Z");
  });

  it("daily: tomorrow when today's slot passed", () => {
    const now = new Date("2026-10-23T20:00:00.000Z"); // 16:00 EDT
    const next = nextRebootOccurrence({
      cadence: "daily",
      weekdays: null,
      localTime: "15:30",
      timezone: "America/New_York",
      now,
    });
    expect(next.toISOString()).toBe("2026-10-24T19:30:00.000Z");
  });

  it("weekly: next matching weekday", () => {
    // 2026-10-23 is Friday (5)
    const now = new Date("2026-10-23T12:00:00.000Z");
    const next = nextRebootOccurrence({
      cadence: "weekly",
      weekdays: [1], // Monday
      localTime: "02:00",
      timezone: "America/New_York",
      now,
    });
    expect(next.toISOString()).toBe("2026-10-26T06:00:00.000Z");
  });

  it("rejects empty weekdays for weekly", () => {
    expect(() =>
      nextRebootOccurrence({
        cadence: "weekly",
        weekdays: [],
        localTime: "02:00",
        timezone: "UTC",
        now: new Date("2026-10-23T00:00:00.000Z"),
      }),
    ).toThrow(/weekday/i);
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

```powershell
cd web; npx vitest run src/lib/reboot-occurrence.test.ts
```

Expected: FAIL (module missing)

- [ ] **Step 4: Implement**

```ts
// web/src/lib/reboot-occurrence.ts
import { DateTime } from "luxon";

export type RebootCadence = "daily" | "weekly";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function nextRebootOccurrence(input: {
  cadence: RebootCadence;
  weekdays: number[] | null;
  localTime: string;
  timezone: string;
  now?: Date;
}): Date {
  const m = TIME_RE.exec(input.localTime);
  if (!m) throw new Error(`Invalid localTime: ${input.localTime}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const zone = input.timezone;
  if (!DateTime.now().setZone(zone).isValid) {
    throw new Error(`Invalid timezone: ${zone}`);
  }
  const now = DateTime.fromJSDate(input.now ?? new Date(), { zone: "utc" });

  if (input.cadence === "weekly") {
    const days = [...new Set(input.weekdays ?? [])].filter(
      (d) => d >= 1 && d <= 7,
    );
    if (!days.length) throw new Error("weekly cadence requires weekdays");
    let best: DateTime | null = null;
    for (let add = 0; add <= 14; add++) {
      const day = now.setZone(zone).startOf("day").plus({ days: add });
      const isoWeekday = day.weekday; // 1=Mon..7=Sun
      if (!days.includes(isoWeekday)) continue;
      let candidate = day.set({
        hour,
        minute,
        second: 0,
        millisecond: 0,
      });
      if (!candidate.isValid) {
        candidate = day.plus({ hours: hour + 1 }).startOf("hour"); // spring gap fallback
      }
      if (candidate.toUTC() <= now) continue;
      if (!best || candidate < best) best = candidate;
    }
    if (!best) throw new Error("could not find next weekly occurrence");
    return best.toUTC().toJSDate();
  }

  // daily
  for (let add = 0; add <= 2; add++) {
    const day = now.setZone(zone).startOf("day").plus({ days: add });
    let candidate = day.set({ hour, minute, second: 0, millisecond: 0 });
    if (!candidate.isValid) {
      candidate = day.plus({ hours: hour + 1 }).startOf("hour");
    }
    if (candidate.toUTC() > now) return candidate.toUTC().toJSDate();
  }
  throw new Error("could not find next daily occurrence");
}
```

(Refine DST fallback in implementation if a fixture fails; keep “strictly after now”.)

- [ ] **Step 5: Run tests — expect PASS**

```powershell
cd web; npx vitest run src/lib/reboot-occurrence.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add web/package.json web/package-lock.json web/src/lib/reboot-occurrence.ts web/src/lib/reboot-occurrence.test.ts
git commit -m "feat(spec 31): next occurrence helper for recurring reboot`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Schema

**Files:**
- Modify: `web/src/db/schema.ts` (after `rebootJobs`)

**Interfaces:**
- Produces: `rebootSchedules` table; `rebootJobs.sourceScheduleId` nullable FK
- Consumes: `assets`, `rebootJobs`

- [ ] **Step 1: Extend `rebootJobs`**

Add column after `sourcePatchInstallJobId`:

```ts
sourceScheduleId: uuid("source_schedule_id"), // FK added after rebootSchedules defined — or forward ref
```

Define `rebootSchedules` first, then add the FK on `rebootJobs` via a second field that references `rebootSchedules.id` with `onDelete: "set null"`. Add index `reboot_jobs_source_schedule_idx` on `sourceScheduleId`.

- [ ] **Step 2: Add `rebootSchedules`**

```ts
export const rebootSchedules = pgTable(
  "reboot_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    cadence: text("cadence").$type<"daily" | "weekly">().notNull(),
    weekdays: integer("weekdays").array(), // null for daily
    localTime: text("local_time").notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    requestedBy: text("requested_by").notNull(),
    nextJobId: uuid("next_job_id"), // set null on job delete — optional FK after jobs
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("reboot_schedules_asset_uidx").on(t.assetId),
  ],
);
export type RebootScheduleRow = typeof rebootSchedules.$inferSelect;
```

Wire `nextJobId` → `rebootJobs.id` with `onDelete: "set null"` if Drizzle allows mutual FKs; otherwise keep as uuid without FK and clear in app code.

- [ ] **Step 3: User applies schema**

```powershell
cd web; npm run db:push
```

- [ ] **Step 4: Commit**

```powershell
git add web/src/db/schema.ts
git commit -m "feat(spec 31): reboot_schedules schema + source_schedule_id`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Schedule DB helpers + materialize

**Files:**
- Create: `web/src/db/reboot-schedules.ts`
- Create: `web/src/db/reboot-schedules.test.ts`
- Modify: `web/src/db/reboot.ts` — extend `enqueueRebootJob` with `sourceScheduleId?: string | null`

**Interfaces:**
- Consumes: `nextRebootOccurrence`, `enqueueRebootJob`, `cancelRebootJob`, schema
- Produces:
  - `upsertRebootSchedule(input: { assetId, targetIp, cadence, weekdays, localTime, timezone, requestedBy }): Promise<{ ok: true; id: string } | { ok: false; reason: "bad-input" }>`
  - `setRebootScheduleEnabled(assetId: string, enabled: boolean): Promise<boolean>`
  - `deleteRebootSchedule(assetId: string): Promise<boolean>`
  - `getRebootScheduleForAssetTag(tag: string): Promise<ScheduleListItem | null>`
  - `materializeRebootSchedule(scheduleId: string): Promise<"created" | "skipped" | "disabled" | "notfound">`
  - `materializeDueRebootSchedules(): Promise<{ checked: number; created: number }>` — all enabled schedules missing an in-flight child
  - `onScheduleJobTerminal(jobId: string): Promise<void>` — if job has `sourceScheduleId`, clear `nextJobId` if matching, then `materializeRebootSchedule`

Upsert algorithm:
1. Validate cadence/weekdays/localTime/timezone via `nextRebootOccurrence` throw → `bad-input`.
2. Cancel any existing pending/claimed/running job with this asset’s schedule `nextJobId` or `sourceScheduleId` for this schedule (after upsert id known).
3. Insert or update the single row on `assetId` (unique).
4. Call `materializeRebootSchedule`.

Materialize algorithm:
1. Load schedule; if missing/disabled → return.
2. If asset has any reboot in `pending|claimed|running` → `skipped`.
3. `scheduledAt = nextRebootOccurrence(...)`.
4. `enqueueRebootJob({ ..., sourceScheduleId: schedule.id })`; on ok set `nextJobId`.

- [ ] **Step 1: Failing tests** (mock `db` like `reboot.test.ts`) covering upsert materialize creates job; second materialize skips; disable cancels child; weekly validation.

- [ ] **Step 2: Implement helpers + extend enqueue**

```ts
// enqueueRebootJob values add:
sourceScheduleId: input.sourceScheduleId ?? null,
```

- [ ] **Step 3: Tests PASS**

```powershell
cd web; npx vitest run src/db/reboot-schedules.test.ts src/db/reboot.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add web/src/db/reboot-schedules.ts web/src/db/reboot-schedules.test.ts web/src/db/reboot.ts
git commit -m "feat(spec 31): reboot schedule upsert and materialize`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Rematerialize on job terminal / cancel

**Files:**
- Modify: `web/src/db/reboot.ts` (`updateRebootStatus`, `cancelRebootJob`)
- Modify: `web/src/db/reboot.test.ts`

**Interfaces:**
- After successful terminal update (`succeeded`/`failed`) or cancel, if returning row has `sourceScheduleId`, call `onScheduleJobTerminal(jobId)` (dynamic import or direct import from `reboot-schedules` — avoid cycle by putting `onScheduleJobTerminal` in `reboot-schedules.ts` and importing it from `reboot.ts`).

- [ ] **Step 1: Test** — when status → succeeded with `sourceScheduleId`, materialize mock called once.

- [ ] **Step 2: Implement hook**

```ts
// in updateRebootStatus after notify, and in cancelRebootJob after notify:
const [full] = await db.select({ sourceScheduleId: rebootJobs.sourceScheduleId }).from(rebootJobs).where(eq(rebootJobs.id, jobId)).limit(1);
if (full?.sourceScheduleId) {
  await onScheduleJobTerminal(jobId);
}
```

(Or return `sourceScheduleId` from `.returning()`.)

- [ ] **Step 3: Tests PASS + commit**

```powershell
git add web/src/db/reboot.ts web/src/db/reboot.test.ts
git commit -m "feat(spec 31): rematerialize recurring reboot after terminal job`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Service tick API + collector poll

**Files:**
- Create: `web/src/app/api/reboot/schedules/due/route.ts`
- Create: `web/src/app/api/reboot/schedules/due/route.test.ts` (mirror `script-schedules/due`)
- Modify: `collector/config.py`, `collector/config.example.yaml`
- Modify: `collector/reachability.py` — `run_reboot_schedules`
- Modify: `collector/worker.py` — schedule job
- Create/modify: `collector/tests/test_reboot_schedules.py`

**Interfaces:**
- `POST /api/reboot/schedules/due` — verify service token + `deploy:agent`; body `{}`; returns `{ checked, created }` from `materializeDueRebootSchedules`.
- Config: `reboot_schedule_interval_minutes: int = 1` (0 = off).

- [ ] **Step 1: Route + test** (401 without token; 200 calls materialize)

- [ ] **Step 2: Collector**

```python
def run_reboot_schedules(config: Config, token: str) -> None:
    try:
        resp = httpx.post(
            f"{config.ingest_url}/api/reboot/schedules/due",
            json={},
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        resp.raise_for_status()
    except Exception as e:
        console.print(f"  [yellow]reboot schedules failed:[/yellow] {e}")
```

Register in `worker.py` like `script_schedules_job` when interval > 0.

- [ ] **Step 3: pytest + vitest PASS + commit**

```powershell
cd collector; uv run pytest -q tests/test_reboot_schedules.py
cd ..\web; npx vitest run src/app/api/reboot/schedules/due/route.test.ts
```

---

### Task 6: Cookie actions

**Files:**
- Modify: `web/src/app/(app)/reboot-actions.ts`
- Create: `web/src/app/(app)/reboot-actions.test.ts` (or extend existing if present)

**Interfaces:**
- `upsertRebootScheduleAction({ assetTag, cadence, weekdays?, localTime, timezone })`
- `setRebootScheduleEnabledAction({ assetTag, enabled })`
- `deleteRebootScheduleAction({ assetTag })`
- Resolve target via `resolveDeployTarget`; gate `software:deploy`; `revalidatePath(/assets/tag)`.

- [ ] **Step 1–4: TDD actions + commit**

```powershell
git add "web/src/app/(app)/reboot-actions.ts" "web/src/app/(app)/reboot-actions.test.ts"
git commit -m "feat(spec 31): recurring reboot schedule actions`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Updates panel UI + page wiring

**Files:**
- Modify: `web/src/components/updates-panel.tsx`
- Modify: `web/src/components/updates-panel.test.tsx`
- Modify: `web/src/components/computer-detail.tsx`
- Modify: `web/src/app/(app)/assets/[id]/page.tsx`
- Extend `pollUpdatesSnapshot` **only if** needed for live schedule display — v1: schedule is server-rendered; after upsert use `router.refresh` **or** return schedule from actions and set local state. Prefer local state update from action result + existing reboot job snapshot poll (no `useRouter` — keep the no-router invariant from #121). Pass `schedule` prop; on successful upsert set from action payload.

**UI block (canInstall):**
- Cadence select: Daily | Weekly  
- Weekly: seven checkboxes Mon–Sun (store ISO 1–7)  
- `type="time"` for local time  
- Show “Next: {local preview}” using `nextRebootOccurrence` in a small client helper or server-provided `nextRunAtIso` on the schedule DTO  
- Buttons: Save schedule, Disable/Enable, Delete  
- History: if `sourceScheduleId` / list field `fromSchedule`, show “ · recurring”

- [ ] **Step 1: Wire page** `getRebootScheduleForAssetTag` beside `listRebootJobsForAssetTag`

- [ ] **Step 2: Panel controls + tests** (render schedule form when canInstall; Save calls upsert mock)

- [ ] **Step 3: Commit**

```powershell
git add web/src/components/updates-panel.tsx web/src/components/updates-panel.test.tsx web/src/components/computer-detail.tsx "web/src/app/(app)/assets/[id]/page.tsx"
git commit -m "feat(spec 31): recurring reboot UI on Updates tab`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Docs

**Files:**
- Modify: `PROGRESS.md` — mark recurring reboot 🚧 / shipped when merged  
- Modify: design spec status → Implemented on branch when coding starts  
- Optional one-liner in `docs/specs/31-patch-management/index.md`

- [ ] **Step 1: Update docs + commit**

```powershell
git add PROGRESS.md docs/superpowers/specs/2026-10-23-spec-31-v2-recurring-reboot-design.md
git commit -m "docs(spec 31): note recurring reboot implementation`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| Per-computer daily/weekly | 1, 3, 6, 7 |
| Skip missed windows | 1 (`>` now), 3 |
| One schedule per asset | 2 unique index, 3 upsert |
| Schedule + materialize one-shot | 3, 4, 5 |
| `source_schedule_id` + history hint | 2, 7 |
| Cancel occurrence keeps series | 4 rematerialize |
| Disable/delete cancels child | 3 |
| One-shot conflict via soft in-flight | existing enqueue + 3 skip |
| Collector unchanged execute path | 5 tick only |
| No fleet / catch-up / install-linked | Global constraints |

**Placeholder scan:** none intentional. DST edge refined in Task 1 if fixtures fail.  
**Types:** `RebootCadence`, ISO weekdays 1–7, `localTime` `HH:MM`, IANA `timezone` consistent across tasks.
