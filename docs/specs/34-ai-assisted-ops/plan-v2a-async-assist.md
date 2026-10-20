# Spec 34 v2a — Async Assist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enqueue Assist as a background job in the Next.js process (`after()`), notify the requesting user with toast + bell when done, and open the Spec 19 bell to all signed-in users with audience filtering.

**Architecture:** `POST /api/ai/assist` inserts `ai_assist_jobs` and returns 202; `after()` runs the existing LLM path, writes result, creates a user-targeted notification. Spec 19 gains `audience`/`recipient_email`; list/SSE/unread filter by viewer. Assist panel shows recent jobs and no longer waits on the provider HTTP call.

**Tech Stack:** Next.js 16 App Router (`after` from `next/server`), Drizzle/Postgres, Spec 19 SSE + sonner toasts, existing `lib/ai/*` + `runAssist` guts.

**Design:** [design-v2-async-assist.md](./design-v2-async-assist.md)

## Global Constraints

- Branch from `main` as `feat/spec-34-v2a-async-assist` before code (never commit on `main`).
- User runs `npm run db:push` / servers; agent provides copy-paste commands.
- No AI auto-run / WinRM; drafts still human Save/Run (spec 32).
- Requester-only Assist notifications (no admin copy).
- Ops notifications stay `audience=admins`; non-admins must not see them.
- Collector is not involved; LLM keys stay on web.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Shell is PowerShell; quote paths with `(app)`.

---

## File map

| File | Responsibility |
|---|---|
| `web/src/db/schema.ts` | `aiAssistJobs` table; `notifications.audience` + `recipientEmail`; new notification types |
| `web/src/lib/data.ts` | `NotificationType` union + optional audience fields on `NotificationItem` if needed |
| `web/src/lib/notification-ui.ts` | Icons/labels for `ai-assist` / `ai-assist-failed` |
| `web/src/lib/notification-visibility.ts` | Pure helper: can viewer see this notification? |
| `web/src/lib/notification-bus.ts` | Extend `NotificationEvent` with `audience` + `recipientEmail` |
| `web/src/db/notifications.ts` | Create input + list/unread SQL filters; `notifyAiAssistResult` |
| `web/src/db/ai-assist-jobs.ts` | Enqueue, process, reclaim, list recent, get by id |
| `web/src/db/ai-assist.ts` | Keep pack/provider/audit helpers used by job processor (refactor sync `runAssist` into shared core) |
| `web/src/app/api/ai/assist/route.ts` | 202 + `after(processJob)` |
| `web/src/app/api/ai/assist/[jobId]/route.ts` | GET status/result |
| `web/src/app/api/notifications/route.ts` | Any authenticated user |
| `web/src/app/api/notifications/stream/route.ts` | Any authenticated user; filter publish by audience |
| `web/src/app/(app)/notification-actions.ts` | Drop admin-only gate (keep auth) |
| `web/src/app/(app)/notifications/page.tsx` | Any signed-in user |
| `web/src/components/notification-bell.tsx` | All users; toast on SSE; pulse when unread |
| `web/src/components/ai-assist-panel.tsx` | Enqueue UX + recent jobs + poll/SSE refresh |
| `web/src/app/(app)/assets/[id]/page.tsx` | Pass recent Assist jobs into `ComputerDetail` |
| `web/.env.example` | No new keys (optional note on job timeout if added) |

---

### Task 1: Schema + notification types

**Files:**
- Modify: `web/src/db/schema.ts` (notifications + new `aiAssistJobs`)
- Modify: `web/src/lib/data.ts` (`NotificationType`)
- Modify: `web/src/lib/notification-ui.ts`
- Test: `web/src/lib/notification-visibility.test.ts` (created in Task 2; types only here)

**Interfaces:**
- Produces: `aiAssistJobs` table export; notification types `ai-assist` | `ai-assist-failed`; columns `audience`, `recipientEmail`

- [ ] **Step 1: Extend `notifications` in schema**

Add after existing notification columns (default keeps Spec 19 behavior):

```ts
audience: text("audience")
  .$type<"admins" | "user">()
  .notNull()
  .default("admins"),
recipientEmail: text("recipient_email"),
```

Add `"ai-assist" | "ai-assist-failed"` to the `type` `$type` union (same places as `script-run`).

- [ ] **Step 2: Add `aiAssistJobs` table**

```ts
export const aiAssistJobs = pgTable(
  "ai_assist_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorEmail: text("actor_email").notNull(),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    scriptRunJobId: uuid("script_run_job_id"),
    userPrompt: text("user_prompt"),
    status: text("status")
      .$type<"pending" | "running" | "succeeded" | "failed">()
      .notNull()
      .default("pending"),
    result: jsonb("result").$type<AssistResult>(),
    error: text("error"),
    contextHash: text("context_hash"),
    provider: text("provider"),
    model: text("model"),
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("ai_assist_jobs_asset_created_idx").on(t.assetId, t.createdAt),
    index("ai_assist_jobs_status_started_idx").on(t.status, t.startedAt),
  ],
);
```

Import `AssistResult` type carefully (avoid circular imports — define a jsonb type inline or import from `@/lib/ai/types`).

- [ ] **Step 3: Mirror types in `lib/data.ts` + icons in `notification-ui.ts`**

Add the two types to `NotificationType`. Map icons (e.g. `Sparkles`) and labels (“AI Assist”, “AI Assist failed”).

- [ ] **Step 4: Commit**

```powershell
git add web/src/db/schema.ts web/src/lib/data.ts web/src/lib/notification-ui.ts
git commit -m @"
feat(spec 34 v2a): schema for assist jobs and notification audience

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: Audience visibility + notification data layer

**Files:**
- Create: `web/src/lib/notification-visibility.ts`
- Create: `web/src/lib/notification-visibility.test.ts`
- Modify: `web/src/db/notifications.ts`
- Modify: `web/src/lib/notification-bus.ts`

**Interfaces:**
- Consumes: schema `audience` / `recipientEmail`
- Produces:
  - `notificationVisibleTo(viewer, n): boolean`
  - `createNotification({ ..., audience?, recipientEmail? })`
  - `listNotifications(viewer, opts)` / `getUnreadCount(viewer)` filtered
  - `notifyAiAssistResult(...)`

- [ ] **Step 1: Write failing visibility tests**

```ts
// web/src/lib/notification-visibility.test.ts
import { describe, expect, it } from "vitest";
import { notificationVisibleTo } from "./notification-visibility";

describe("notificationVisibleTo", () => {
  it("shows admin broadcasts only to admins", () => {
    expect(
      notificationVisibleTo(
        { email: "a@x.com", isAdmin: true },
        { audience: "admins", recipientEmail: null },
      ),
    ).toBe(true);
    expect(
      notificationVisibleTo(
        { email: "t@x.com", isAdmin: false },
        { audience: "admins", recipientEmail: null },
      ),
    ).toBe(false);
  });

  it("shows user-targeted only to matching email", () => {
    expect(
      notificationVisibleTo(
        { email: "t@x.com", isAdmin: false },
        { audience: "user", recipientEmail: "t@x.com" },
      ),
    ).toBe(true);
    expect(
      notificationVisibleTo(
        { email: "other@x.com", isAdmin: true },
        { audience: "user", recipientEmail: "t@x.com" },
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```powershell
cd web; npx vitest run src/lib/notification-visibility.test.ts
```

- [ ] **Step 3: Implement helper**

```ts
// web/src/lib/notification-visibility.ts
export type NotificationAudience = "admins" | "user";

export function notificationVisibleTo(
  viewer: { email: string; isAdmin: boolean },
  n: { audience: NotificationAudience; recipientEmail: string | null },
): boolean {
  if (n.audience === "admins") return viewer.isAdmin;
  return (
    n.audience === "user" &&
    !!n.recipientEmail &&
    n.recipientEmail.toLowerCase() === viewer.email.toLowerCase()
  );
}
```

- [ ] **Step 4: Update bus event shape**

Add to `NotificationEvent`:

```ts
audience: "admins" | "user";
recipientEmail: string | null;
```

Publish these from `createNotification`.

- [ ] **Step 5: Update `createNotification`**

Extend input:

```ts
audience?: "admins" | "user"; // default "admins"
recipientEmail?: string | null; // required when audience === "user"
```

Validate: if `audience === "user"` and no email, log error and return null. Insert columns. Publish extended event.

- [ ] **Step 6: Filter `listNotifications` / `getUnreadCount`**

Change signatures to accept:

```ts
viewer: { userKey: string; email: string; isAdmin: boolean }
```

SQL where (Drizzle `or` / `and`):

- `(audience = 'admins' AND :isAdmin)` OR  
- `(audience = 'user' AND recipient_email = :email)`  

Use `sql` fragments or `or(and(...), and(...))`. Keep read-join on `userKey` unchanged.

Update all call sites (API routes, actions) to pass `isAdmin: hasPermission(user, "user:admin")` and `email: user.email`.

- [ ] **Step 7: Add `notifyAiAssistResult`**

```ts
export async function notifyAiAssistResult(input: {
  jobId: string;
  actorEmail: string;
  assetTag: string;
  assetId: string | null;
  action: string;
  ok: boolean;
  error?: string | null;
}): Promise<string | null> {
  const href = `/assets/${input.assetTag}?tab=monitoring&assistJob=${input.jobId}`;
  return createNotification({
    type: input.ok ? "ai-assist" : "ai-assist-failed",
    severity: input.ok ? "info" : "warning",
    title: input.ok ? "AI Assist finished" : "AI Assist failed",
    body: input.ok
      ? `Assist (${input.action}) is ready.`
      : `Assist (${input.action}) failed${input.error ? `: ${input.error.slice(0, 200)}` : "."}`,
    href,
    dedupeKey: `ai-assist:${input.jobId}:${input.ok ? "ok" : "fail"}`,
    assetId: input.assetId,
    audience: "user",
    recipientEmail: input.actorEmail,
    meta: { jobId: input.jobId, action: input.action },
  });
}
```

- [ ] **Step 8: Run visibility tests — PASS; fix any broken notification route tests**

```powershell
cd web; npx vitest run src/lib/notification-visibility.test.ts src/app/api/notifications/route.test.ts
```

- [ ] **Step 9: Commit**

```powershell
git add web/src/lib/notification-visibility.ts web/src/lib/notification-visibility.test.ts web/src/lib/notification-bus.ts web/src/db/notifications.ts web/src/app/api/notifications/
git commit -m @"
feat(spec 19/34): user-targeted notifications and audience filters

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Bell, SSE, toast for all signed-in users

**Files:**
- Modify: `web/src/app/api/notifications/route.ts`
- Modify: `web/src/app/api/notifications/stream/route.ts`
- Modify: `web/src/app/(app)/notification-actions.ts`
- Modify: `web/src/app/(app)/notifications/page.tsx`
- Modify: `web/src/components/notification-bell.tsx`
- Modify: `web/src/app/api/notifications/route.test.ts`

**Interfaces:**
- Consumes: `notificationVisibleTo`, filtered list/unread
- Produces: toast on SSE; bell pulse when `unread > 0`

- [ ] **Step 1: Open REST + actions + page to any authenticated user**

Replace `user:admin` gates with “must be logged in”. Pass viewer `{ userKey, email, isAdmin }` into list/count.

Update `/notifications` page copy: remove “admins only” placeholder; allow any signed-in user (feed still filtered).

- [ ] **Step 2: Open SSE; filter events**

```ts
const user = await getCurrentUser();
if (!user) return new Response("unauthorized", { status: 401 });
const isAdmin = hasPermission(user, "user:admin");
// remove admin-only 403

unsubscribe = subscribeNotifications((n) => {
  if (
    !notificationVisibleTo(
      { email: user.email, isAdmin },
      { audience: n.audience, recipientEmail: n.recipientEmail },
    )
  ) {
    return;
  }
  sendEvent("notification", n);
  // optionally recompute unread via getUnreadCount
});
```

- [ ] **Step 3: Bell UI — any user; toast; pulse**

In `NotificationBell`:

- Remove `if (!isAdmin) return null` (or gate only on “has session” via user provider).
- On SSE `notification`: `toast.success(n.title)` or `toast.error` when type ends with `-failed` / severity warning|critical; keep existing prepend + unread bump.
- Add `animate-pulse` (or ring) to the Bell icon / button when `unread > 0`.

- [ ] **Step 4: Update route tests for non-admin 200**

Expect authenticated non-admin GET `/api/notifications` → 200 (mock list empty).

- [ ] **Step 5: Commit**

```powershell
git commit -m @"
feat(spec 19): bell and SSE for all users with audience filtering

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: Assist job queue + processor

**Files:**
- Create: `web/src/db/ai-assist-jobs.ts`
- Create: `web/src/db/ai-assist-jobs.test.ts` (unit tests for reclaim eligibility helpers if pure; otherwise mock db lightly)
- Modify: `web/src/db/ai-assist.ts` (extract shared `executeAssistCore` used by processor)

**Interfaces:**
- Produces:
  - `enqueueAssistJob(input) => { id: string }`
  - `processAssistJob(jobId: string) => Promise<void>`
  - `reclaimStuckAssistJobs(olderThanMs?: number) => Promise<number>`
  - `getAssistJob(jobId)`, `listAssistJobsForAssetTag(tag, limit)`
- Consumes: context pack, provider, parse, audit insert, `notifyAiAssistResult`

- [ ] **Step 1: Refactor `ai-assist.ts`**

Split so processor can call a function that:

1. Builds pack / script-run extra  
2. Calls provider + parse  
3. Writes `ai_assist_events`  
4. Returns `{ ok, result?, error?, provider, model, contextHash, assetId }`  

Keep exporting anything tests need. Sync `runAssist` can remain as a thin wrapper for tests or be removed once jobs own the path.

- [ ] **Step 2: Implement enqueue**

```ts
export async function enqueueAssistJob(input: {
  action: AssistAction;
  assetTag: string;
  actorEmail: string;
  scriptRunJobId?: string;
  userPrompt?: string;
}): Promise<{ id: string } | { error: "not_configured" | "not_found" }> {
  await reclaimStuckAssistJobs(); // opportunistic
  if (!isAiConfigured()) return { error: "not_configured" };
  // resolve asset uuid by tag+Computer;  not_found if missing
  const [row] = await db.insert(aiAssistJobs).values({...}).returning({ id: aiAssistJobs.id });
  return { id: row.id };
}
```

- [ ] **Step 3: Implement `processAssistJob`**

```ts
export async function processAssistJob(jobId: string): Promise<void> {
  // load job; if not pending/running skip
  // set running + startedAt
  // call executeAssistCore(...)
  // on success: status succeeded, result, finishedAt, audit already in core
  // on failure: status failed, error
  // notifyAiAssistResult(...); store notificationId if returned
}
```

Never throw out of `after()` without catching — log and mark failed.

- [ ] **Step 4: Implement reclaim**

```ts
const STUCK_MS = 10 * 60 * 1000;

export async function reclaimStuckAssistJobs(
  olderThanMs = STUCK_MS,
): Promise<number> {
  // select running where startedAt < now - olderThanMs
  // mark failed, error = "Assist interrupted (timed out or server restarted)"
  // notify each actor once (dedupeKey includes job id + fail)
}
```

- [ ] **Step 5: `getAssistJob` / `listAssistJobsForAssetTag`**

Authorize later in routes; DB helpers return rows (id, status, action, result, error, createdAt, finishedAt, actorEmail, assetId).

- [ ] **Step 6: Commit**

```powershell
git commit -m @"
feat(spec 34 v2a): assist job enqueue, process, and stuck reclaim

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 5: API routes (202 + GET)

**Files:**
- Modify: `web/src/app/api/ai/assist/route.ts`
- Create: `web/src/app/api/ai/assist/[jobId]/route.ts`
- Create: `web/src/app/api/ai/assist/route.test.ts` (optional light mock)

**Interfaces:**
- Consumes: `enqueueAssistJob`, `processAssistJob`, `getAssistJob`
- Produces: POST 202 `{ jobId }`; GET job payload

- [ ] **Step 1: Rewrite POST**

```ts
import { after } from "next/server";

// auth + action/perm checks unchanged from v1
const enq = await enqueueAssistJob({...});
if (enq.error === "not_configured") return NextResponse.json(..., { status: 503 });
if (enq.error === "not_found") return NextResponse.json(..., { status: 404 });

after(() => processAssistJob(enq.id));

return NextResponse.json({ jobId: enq.id }, { status: 202 });
```

Do **not** await `processAssistJob` in the request path.

- [ ] **Step 2: GET `[jobId]`**

```ts
const user = await getCurrentUser();
if (!user) return 401;
const job = await getAssistJob(params.jobId);
if (!job) return 404;
const isAdmin = hasPermission(user, "user:admin");
if (job.actorEmail !== user.email && !isAdmin) return 403;
return NextResponse.json({
  id: job.id,
  status: job.status,
  action: job.action,
  result: job.result,
  error: job.error,
  createdAt: ...,
  finishedAt: ...,
});
```

- [ ] **Step 3: Manual sanity (user)**

```powershell
# after db:push and AI configured — POST should return in <1s with jobId
```

- [ ] **Step 4: Commit**

```powershell
git commit -m @"
feat(spec 34 v2a): async assist API with after() processing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 6: Assist panel + computer page wiring

**Files:**
- Modify: `web/src/components/ai-assist-panel.tsx`
- Modify: `web/src/components/computer-detail.tsx` (pass recent jobs / deep-link query)
- Modify: `web/src/app/(app)/assets/[id]/page.tsx`
- Modify: `web/src/components/computer-detail.test.tsx` / panel tests as needed
- Create: `web/src/db` list helper already in Task 4 — call from page

**Interfaces:**
- Consumes: POST 202, GET job, `listAssistJobsForAssetTag`
- Produces: queued UX; recent list; draft handoff unchanged

- [ ] **Step 1: Load recent jobs on the asset page**

```ts
const recentAssistJobs = aiEnabled
  ? await listAssistJobsForAssetTag(id, 5)
  : [];
// pass to ComputerDetail → MonitoringBody → AiAssistPanel
```

- [ ] **Step 2: Panel enqueue behavior**

```ts
const res = await fetch("/api/ai/assist", { method: "POST", ... });
if (res.status === 202) {
  const { jobId } = await res.json();
  toast.message("AI Assist queued");
  setActiveJobId(jobId);
  // poll GET every 2s while mounted OR wait for matching notification meta.jobId
  return;
}
```

When GET shows `succeeded`, set `result` from `job.result`. On `failed`, toast already from bell; show error in panel.

- [ ] **Step 3: Recent jobs UI**

List last 5: action, status, time; click expands/loads that result. Prefer server-provided initial list + refresh after completion.

- [ ] **Step 4: Deep link**

Read `assistJob` searchParam (and `tab=monitoring`) on computer detail — switch Monitoring → Assist sub-tab and select that job. Notification href from Task 2 already includes these query params.

- [ ] **Step 5: Tests**

Update computer-detail AI tests: enqueue mock fetch 202; Assist still under Monitoring.

- [ ] **Step 6: Commit**

```powershell
git commit -m @"
feat(spec 34 v2a): Assist panel enqueue, recent jobs, deep-link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 7: Docs + ship checklist

**Files:**
- Modify: `docs/specs/34-ai-assisted-ops/design-v2-async-assist.md` (Status → Implementing / Accepted)
- Modify: `docs/specs/34-ai-assisted-ops/index.md` if needed

- [ ] **Step 1: Mark design status**

`Status: Accepted (implementing on feat/spec-34-v2a-async-assist)` then after merge `Accepted (shipped)`.

- [ ] **Step 2: User verify**

```powershell
cd d:\Code\aw\aw-inventory\web
npm run db:push
# restart npm run dev
# as non-admin tech: confirm bell visible
# Summarize health → toast when done on another tab; bell pulses; panel shows result
```

- [ ] **Step 3: Final commit on docs if dirty**

```powershell
git commit -m @"
docs(spec 34): mark v2a async assist implementing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

## Spec coverage checklist

| AC | Task |
|---|---|
| AC-A1 POST returns quickly + after() | 5 |
| AC-A2 requester notification + toast | 2, 3, 4 |
| AC-A3 no notify while pending/running | 4 (notify only terminal) |
| AC-A4 bell all users; ops admin-only in feed | 2, 3 |
| AC-A5 recent jobs + deep-link | 6 |
| AC-A6 stuck reclaim | 4 |
| AC-A7 audit hash + redact | 4 (reuse v1 core) |

## Parked (do not implement in this plan)

B fleet correlation · C recurring reports · D on-prem/PII · E KB · requester notify for all worker jobs
