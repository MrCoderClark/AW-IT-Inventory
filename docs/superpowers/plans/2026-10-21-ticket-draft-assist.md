# Ticket draft assist (from notification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin clicks Create ticket on a notification and AI is configured, draft subject/description (optional category/priority) from the alert before insert; auto-create stays raw; AI failure falls back to today’s fields.

**Architecture:** Extend Assist types/parse for `draft_ticket` + `ticketDraft`. Add a notification context pack and a sync helper that calls the AI provider. `createTicketFromNotification(..., { useAi })` applies the draft only when `useAi` is true; the server action passes `useAi: true`, auto-create passes false / omits.

**Tech Stack:** Existing Spec 34 AI gateway (`getAiProvider`, `loadAiConfig`), Drizzle notifications/assets, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-21-ticket-draft-assist-design.md`](../specs/2026-10-21-ticket-draft-assist-design.md)

## Global Constraints

- Manual Create ticket only (`user:admin`); auto-create **never** calls AI
- Sync provider call with fallback on off/error/timeout — create always succeeds if notification exists
- Fields: subject + description required from draft; category must be in `TICKET_CATEGORIES`; priority `low|medium|high` or discard
- No secrets in context pack; truncate long bodies
- Do not require Assist job queue for this path
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell; quote `(app)` paths

---

## File structure

| File | Role |
|---|---|
| `web/src/lib/ai/types.ts` | `draft_ticket` action + `ticketDraft` on result |
| `web/src/lib/ai/parse.ts` + `.test.ts` | Parse `ticketDraft` |
| `web/src/db/ai-context.ts` | `buildNotificationContextPack` |
| `web/src/db/ai-ticket-draft.ts` (+ test) | Sync draft helper |
| `web/src/db/tickets.ts` | `useAi` option on create-from-notification |
| `web/src/db/tickets.test.ts` | Auto-create no AI; manual AI apply/fallback |
| `web/src/app/(app)/ticket-actions.ts` | Pass `useAi: true` |
| Spec 34 / Spec 33 / PROGRESS / design Status | Docs |

---

### Task 1: Types + parse `ticketDraft`

**Files:**
- Modify: `web/src/lib/ai/types.ts`
- Modify: `web/src/lib/ai/parse.ts`
- Modify: `web/src/lib/ai/parse.test.ts`

**Interfaces:**
- Produces: `AssistAction` includes `"draft_ticket"`; `AssistResult.ticketDraft?: { subject; description; category?; priority? }`

- [ ] **Step 1: Failing parse test**

Append to `parse.test.ts`:

```ts
  it("parses ticketDraft for draft_ticket", () => {
    const r = parseAssistResult(
      JSON.stringify({
        observed: ["Disk alert"],
        hypotheses: [],
        recommendations: [],
        ticketDraft: {
          subject: "Disk space critical on PC-1",
          description: "Free space below threshold. Investigate cleanup.",
          category: "Alert",
          priority: "high",
        },
      }),
    );
    expect(r.ticketDraft).toEqual({
      subject: "Disk space critical on PC-1",
      description: "Free space below threshold. Investigate cleanup.",
      category: "Alert",
      priority: "high",
    });
  });

  it("omits ticketDraft when subject/description missing", () => {
    const r = parseAssistResult(
      JSON.stringify({
        observed: [],
        hypotheses: [],
        recommendations: [],
        ticketDraft: { subject: "", description: "x" },
      }),
    );
    expect(r.ticketDraft).toBeUndefined();
  });
```

- [ ] **Step 2: Run — expect FAIL** (ticketDraft not parsed)

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ai/parse.test.ts --run
```

- [ ] **Step 3: Implement types + parse**

In `types.ts`:

```ts
export type AssistAction =
  | "summarize_health"
  | "explain_failures"
  | "summarize_script_run"
  | "draft_script"
  | "draft_ticket";

export type AssistResult = {
  observed: string[];
  hypotheses: string[];
  recommendations: string[];
  scriptDraft?: { name?: string; body: string; notes?: string };
  ticketDraft?: {
    subject: string;
    description: string;
    category?: string;
    priority?: "low" | "medium" | "high";
  };
};
```

In `parse.ts`, after scriptDraft block:

```ts
  const td = o.ticketDraft;
  if (td && typeof td === "object") {
    const d = td as Record<string, unknown>;
    const subject = typeof d.subject === "string" ? d.subject.trim() : "";
    const description =
      typeof d.description === "string" ? d.description.trim() : "";
    if (subject && description) {
      const priority =
        d.priority === "low" || d.priority === "medium" || d.priority === "high"
          ? d.priority
          : undefined;
      result.ticketDraft = {
        subject,
        description,
        category: typeof d.category === "string" ? d.category.trim() : undefined,
        priority,
      };
    }
  }
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/lib/ai/types.ts web/src/lib/ai/parse.ts web/src/lib/ai/parse.test.ts
git commit -m @"
feat(spec 34): parse ticketDraft assist result

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: Notification context pack + sync draft helper

**Files:**
- Modify: `web/src/db/ai-context.ts` (+ tests if file has them, else `ai-context` section in new test)
- Create: `web/src/db/ai-ticket-draft.ts`
- Create: `web/src/db/ai-ticket-draft.test.ts`

**Interfaces:**
- Produces:
  - `buildNotificationContextPack(notificationId: string): Promise<NotificationContextPack | null>`
  - `draftTicketFieldsFromNotification(notificationId: string, actorEmail: string): Promise<TicketDraftFields | null>`
    - returns `null` when AI off, pack missing, or provider/parse failure
    - `TicketDraftFields = { subject; description; category?: string; priority?: ... }` with category validated via `isTicketCategory`

- [ ] **Step 1: Write failing helper tests**

```ts
// ai-ticket-draft.test.ts — mock db/provider as existing ai-assist tests do
import { describe, expect, it, vi, beforeEach } from "vitest";

const completeMock = vi.fn();
const packMock = vi.fn();

vi.mock("@/lib/ai/config", () => ({
  loadAiConfig: () => ({
    provider: "openai_compatible",
    baseUrl: "https://example.test",
    apiKey: "k",
    model: "m",
    timeoutMs: 5000,
  }),
  isAiConfigured: () => true,
}));

vi.mock("@/lib/ai/providers", () => ({
  getAiProvider: () => ({
    id: "openai_compatible",
    model: "m",
    complete: completeMock,
  }),
  AiNotConfiguredError: class extends Error {},
}));

vi.mock("./ai-context", () => ({
  buildNotificationContextPack: (...a: unknown[]) => packMock(...a),
}));

vi.mock("./index", () => ({ db: {} })); // if recordAssistEvent needs db, mock record path or stub

import { draftTicketFieldsFromNotification } from "./ai-ticket-draft";

describe("draftTicketFieldsFromNotification", () => {
  beforeEach(() => {
    completeMock.mockReset();
    packMock.mockReset();
  });

  it("returns null when pack missing", async () => {
    packMock.mockResolvedValue(null);
    expect(await draftTicketFieldsFromNotification("n1", "a@b.com")).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("returns validated draft on success", async () => {
    packMock.mockResolvedValue({
      notification: {
        type: "metric-threshold",
        severity: "critical",
        title: "Disk",
        body: "95%",
      },
      asset: { tag: "PC-1", name: "PC-1", type: "Computer", locationPath: null },
    });
    completeMock.mockResolvedValue(
      JSON.stringify({
        observed: [],
        hypotheses: [],
        recommendations: [],
        ticketDraft: {
          subject: "Disk critical on PC-1",
          description: "Clean up or expand volume.",
          category: "Alert",
          priority: "high",
        },
      }),
    );
    await expect(
      draftTicketFieldsFromNotification("n1", "a@b.com"),
    ).resolves.toEqual({
      subject: "Disk critical on PC-1",
      description: "Clean up or expand volume.",
      category: "Alert",
      priority: "high",
    });
  });

  it("drops invalid category", async () => {
    packMock.mockResolvedValue({
      notification: {
        type: "metric-threshold",
        severity: "warning",
        title: "t",
        body: "b",
      },
      asset: null,
    });
    completeMock.mockResolvedValue(
      JSON.stringify({
        observed: [],
        hypotheses: [],
        recommendations: [],
        ticketDraft: {
          subject: "Sub",
          description: "Desc",
          category: "NotARealCategory",
          priority: "nope",
        },
      }),
    );
    await expect(
      draftTicketFieldsFromNotification("n1", "a@b.com"),
    ).resolves.toEqual({
      subject: "Sub",
      description: "Desc",
    });
  });
});
```

Adjust mocks to match how `recordAssistEvent` is imported (spy/mock `./ai-assist` audit or inline a minimal audit stub in the helper that is mockable). Prefer **not** writing `ai_assist_events` from the ticket-draft helper if that couples tests — either call a small `recordAssistEvent` export already in `ai-assist.ts` behind try/catch, or skip audit for this slice and note in report (design allows direct provider call; audit is nice-to-have). **Prefer:** reuse `recordAssistEvent` from `ai-assist.ts` if exported; else skip audit in v1 of this slice to keep the helper small.

- [ ] **Step 2: Run — FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/db/ai-ticket-draft.test.ts --run
```

- [ ] **Step 3: Implement pack + helper**

`NotificationContextPack` in `ai-context.ts`:

```ts
export type NotificationContextPack = {
  notification: {
    type: string;
    severity: string;
    title: string;
    body: string; // truncated e.g. 2000 chars
  };
  asset: {
    tag: string;
    name: string;
    type: string;
    locationPath: string | null;
  } | null;
};

export async function buildNotificationContextPack(
  notificationId: string,
): Promise<NotificationContextPack | null> {
  // select notification; if assetId, join asset + location name
  // redactDeep the pack before return
}
```

`ai-ticket-draft.ts`:

```ts
export type TicketDraftFields = {
  subject: string;
  description: string;
  category?: string;
  priority?: "low" | "medium" | "high";
};

const TICKET_JSON_HINT = `{
  "observed": string[],
  "hypotheses": string[],
  "recommendations": string[],
  "ticketDraft": {
    "subject": string,
    "description": string,
    "category"?: string,
    "priority"?: "low"|"medium"|"high"
  }
}
Rules: Write a clear IT ticket from the notification context. subject ≤ 120 chars.
category must be one of the fixed ticket categories when possible. Do not invent asset facts.`;

export async function draftTicketFieldsFromNotification(
  notificationId: string,
  actorEmail: string,
): Promise<TicketDraftFields | null> {
  const cfg = loadAiConfig();
  if (!isAiConfigured(cfg)) return null;
  const pack = await buildNotificationContextPack(notificationId);
  if (!pack) return null;
  try {
    const provider = getAiProvider(cfg);
    const raw = await provider.complete({
      system: `You are an IT helpdesk assistant for H2Tecs. Draft one ticket from an alert notification. Never claim to have fixed anything.`,
      user: `Action: draft_ticket\n\nContext pack (JSON):\n${JSON.stringify(pack)}`,
      jsonSchemaHint: TICKET_JSON_HINT,
    });
    const parsed = parseAssistResult(raw).ticketDraft;
    if (!parsed) return null;
    const out: TicketDraftFields = {
      subject: parsed.subject.slice(0, 200),
      description: parsed.description,
    };
    if (parsed.category && isTicketCategory(parsed.category)) {
      out.category = parsed.category;
    }
    if (parsed.priority) out.priority = parsed.priority;
    return out;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/ai-context.ts web/src/db/ai-ticket-draft.ts web/src/db/ai-ticket-draft.test.ts
git commit -m @"
feat(spec 34): draft ticket fields from notification context

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Wire create-from-notification + action

**Files:**
- Modify: `web/src/db/tickets.ts`
- Modify: `web/src/db/tickets.test.ts`
- Modify: `web/src/app/(app)/ticket-actions.ts`
- Modify: `web/src/app/(app)/ticket-actions.test.ts` if needed

**Interfaces:**
- `createTicketFromNotification(id, createdBy, opts?: { useAi?: boolean })`
- Action passes `{ useAi: true }`; `maybeAutoCreate` unchanged (no third arg)

- [ ] **Step 1: Failing tests**

In `tickets.test.ts`:

```ts
  it("does not call AI draft when useAi is omitted (auto-create path)", async () => {
    // existing createTicketFromNotification test setup
    // mock draftTicketFieldsFromNotification and assert not called
  });

  it("applies AI draft when useAi true and draft returns fields", async () => {
    // mock draft to return subject/description/priority
    // assert createTicket insert uses those fields
  });

  it("falls back to notification title/body when draft returns null", async () => {
    // useAi true, draft null → subject = title
  });
```

Use `vi.mock("./ai-ticket-draft")` at top of tickets.test.ts carefully (existing mock harness). Prefer injecting via mock of the module.

- [ ] **Step 2: Implement**

```ts
export async function createTicketFromNotification(
  notificationId: string,
  createdBy: string,
  opts?: { useAi?: boolean },
): Promise<{ id: string; number: number } | { existingId: string } | null> {
  const [notif] = await db.select(...).where(...).limit(1);
  if (!notif) return null;

  let subject = notif.title;
  let description = notif.body;
  let category = categoryFromNotificationType(notif.type as NotificationType);
  let priority: TicketPriority | undefined;

  if (opts?.useAi) {
    const { draftTicketFieldsFromNotification } = await import("./ai-ticket-draft");
    const draft = await draftTicketFieldsFromNotification(
      notificationId,
      createdBy,
    );
    if (draft) {
      subject = draft.subject;
      description = draft.description;
      if (draft.category) category = draft.category;
      if (draft.priority) priority = draft.priority;
    }
  }

  return createTicket({
    subject,
    description,
    assetId: notif.assetId,
    sourceNotificationId: notif.id,
    category,
    priority, // only if createTicket accepts optional priority — check signature; if not, omit or extend createTicket
    createdBy,
  });
}
```

Check `createTicket` for optional `priority` — if required with default `medium`, pass `priority: draft.priority ?? "medium"` only when drafting, else leave default.

In `ticket-actions.ts`:

```ts
  const result = await createTicketFromNotification(
    notificationId,
    user!.email,
    { useAi: true },
  );
```

- [ ] **Step 3: Run tests**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/db/tickets.test.ts "src/app/(app)/ticket-actions.test.ts" src/db/ai-ticket-draft.test.ts --run
```

- [ ] **Step 4: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/tickets.ts web/src/db/tickets.test.ts "web/src/app/(app)/ticket-actions.ts" "web/src/app/(app)/ticket-actions.test.ts"
git commit -m @"
feat(spec 34): AI-enhance manual create ticket from notification

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: Docs

**Files:**
- Modify: `docs/specs/34-ai-assisted-ops/index.md` — promote ticket-draft to a shipped/v2c phase line
- Modify: `docs/specs/33-ticketing/index.md` — note AI draft on manual create
- Modify: `PROGRESS.md`
- Modify: design Status → implemented

- [ ] **Step 1: Update Spec 34 phases**

Replace Later bullet partially:

```md
5. **v2c — ticket draft assist** — [design](../../superpowers/specs/2026-10-21-ticket-draft-assist-design.md):
   manual Create ticket from notification uses AI draft when configured;
   auto-create stays raw. (shipped on feat/spec-34-ticket-draft-assist)
6. **Later** — streaming UI; admin prompt retention opt-in; computer Assist
   “Draft ticket”; email-in still Spec 33.
```

- [ ] **Step 2: PROGRESS + design status**

- [ ] **Step 3: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add docs/specs/34-ai-assisted-ops/index.md docs/specs/33-ticketing/index.md PROGRESS.md docs/superpowers/specs/2026-10-21-ticket-draft-assist-design.md
git commit -m @"
docs(spec 34): mark ticket draft assist from notification

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

## Spec coverage

| AC | Task |
|---|---|
| AC-T1 AI draft on manual create | Task 2–3 |
| AC-T2 fallback | Task 2–3 |
| AC-T3 auto-create no AI | Task 3 |
| AC-T4 invalid category/priority | Task 2 |
| AC-T5 dedupe | unchanged + Task 3 |
| AC-T6 no secrets | Task 2 pack |

## Placeholder scan

None intentional; implementers must resolve `createTicket` priority optional field against the real signature.

## Type consistency

`draft_ticket` / `ticketDraft` / `TicketDraftFields` / `useAi` as above.
