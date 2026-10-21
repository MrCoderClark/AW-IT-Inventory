# Simple ticket SLA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pure-compute soft-pause SLA labels, an SLA Breached KPI, list/detail display, and a CSV SLA column.

**Architecture:** Pure helpers in `ticket-sla.ts` derive state from `createdAt` + priority + status. KPI/list/detail/CSV all call the same helpers at render/export time. No schema changes.

**Tech Stack:** TypeScript, Vitest, existing tickets UI components, ticket-csv.

**Spec:** [`docs/superpowers/specs/2026-10-21-ticket-simple-sla-design.md`](../specs/2026-10-21-ticket-simple-sla-design.md)

## Global Constraints

- Budgets: High **4h**, Medium **8h**, Low **24h** (wall clock from `createdAt`)
- Soft pause: `waiting_on_user` → label `Paused`; never breached while waiting; due does not extend
- Terminal `resolved` / `closed` → label `—`
- Active overdue → label `Overdue`; else `Nh left` / `Nm left`
- Priority change retargets immediately (same `createdAt`)
- No DB columns / no `db:push`
- No escalation UI / no business hours / no vs-yesterday deltas
- CSV gains **SLA** column after Status
- Shell is PowerShell; commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File structure

| File | Role |
|---|---|
| `web/src/lib/ticket-sla.ts` | Budgets + state + format + breach |
| `web/src/lib/ticket-sla.test.ts` | Unit tests |
| `web/src/lib/ticket-ui.ts` | Extend `ticketKpiCounts` with `slaBreached` |
| `web/src/lib/ticket-ui.test.ts` | Update KPI tests |
| `web/src/components/ticket-kpi-strip.tsx` | Fifth card |
| `web/src/components/tickets-view.tsx` | SLA column |
| `web/src/components/ticket-workspace.tsx` | SLA meta row |
| `web/src/lib/ticket-csv.ts` / `.test.ts` | SLA column |
| Spec 33 index, PROGRESS, design Status | Docs |

---

### Task 1: `ticket-sla` helpers

**Files:**
- Create: `web/src/lib/ticket-sla.ts`
- Create: `web/src/lib/ticket-sla.test.ts`

**Interfaces:**
- Produces:
  - `TICKET_SLA_BUDGET_MS: Record<TicketPriority, number>`
  - `TicketSlaKind = "none" | "paused" | "ok" | "breached"`
  - `ticketSlaState(ticket: { createdAt: string; priority: TicketPriority; status: TicketStatus }, now?: Date): { kind: TicketSlaKind; dueAt: Date | null; label: string }`
  - `formatSlaRemaining(ms: number): string` (ms > 0)

- [ ] **Step 1: Write failing tests**

Create `web/src/lib/ticket-sla.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  formatSlaRemaining,
  TICKET_SLA_BUDGET_MS,
  ticketSlaState,
} from "@/lib/ticket-sla";

const CREATED = "2026-10-21T12:00:00.000Z";

describe("ticket SLA", () => {
  it("exposes fixed budgets", () => {
    expect(TICKET_SLA_BUDGET_MS.high).toBe(4 * 60 * 60 * 1000);
    expect(TICKET_SLA_BUDGET_MS.medium).toBe(8 * 60 * 60 * 1000);
    expect(TICKET_SLA_BUDGET_MS.low).toBe(24 * 60 * 60 * 1000);
  });

  it("formats remaining time", () => {
    expect(formatSlaRemaining(3 * 60 * 60 * 1000)).toBe("3h left");
    expect(formatSlaRemaining(45 * 60 * 1000)).toBe("45m left");
    expect(formatSlaRemaining(30 * 1000)).toBe("1m left");
  });

  it("returns none for terminal statuses", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "resolved" },
        now,
      ),
    ).toMatchObject({ kind: "none", label: "—", dueAt: null });
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "closed" },
        now,
      ).kind,
    ).toBe("none");
  });

  it("returns paused for waiting_on_user even if past due", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const s = ticketSlaState(
      { createdAt: CREATED, priority: "high", status: "waiting_on_user" },
      now,
    );
    expect(s).toMatchObject({ kind: "paused", label: "Paused" });
    expect(s.dueAt?.toISOString()).toBe("2026-10-21T16:00:00.000Z");
  });

  it("returns ok with remaining label before due", () => {
    const now = new Date("2026-10-21T13:00:00.000Z"); // 3h left on high/4h
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "open" },
        now,
      ),
    ).toMatchObject({ kind: "ok", label: "3h left" });
  });

  it("returns breached when past due and active", () => {
    const now = new Date("2026-10-21T17:00:00.000Z"); // 1h past high/4h
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "in_progress" },
        now,
      ),
    ).toMatchObject({ kind: "breached", label: "Overdue" });
  });

  it("retargets when priority changes", () => {
    const now = new Date("2026-10-21T15:00:00.000Z"); // 3h after create
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "open" },
        now,
      ).kind,
    ).toBe("breached"); // high due at +4h = 16:00
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "medium", status: "open" },
        now,
      ),
    ).toMatchObject({ kind: "ok", label: "5h left" }); // med due +8h = 20:00
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-sla.test.ts --run
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `web/src/lib/ticket-sla.ts`:

```ts
import type { TicketPriority, TicketStatus } from "@/lib/data";

export const TICKET_SLA_BUDGET_MS: Record<TicketPriority, number> = {
  high: 4 * 60 * 60 * 1000,
  medium: 8 * 60 * 60 * 1000,
  low: 24 * 60 * 60 * 1000,
};

export type TicketSlaKind = "none" | "paused" | "ok" | "breached";

export type TicketSlaState = {
  kind: TicketSlaKind;
  dueAt: Date | null;
  label: string;
};

/** Human remaining for positive ms: whole hours if ≥1h, else minutes (min 1m). */
export function formatSlaRemaining(ms: number): string {
  if (ms >= 60 * 60 * 1000) {
    return `${Math.floor(ms / (60 * 60 * 1000))}h left`;
  }
  return `${Math.max(1, Math.ceil(ms / (60 * 1000)))}m left`;
}

export function ticketSlaState(
  ticket: {
    createdAt: string;
    priority: TicketPriority;
    status: TicketStatus;
  },
  now: Date = new Date(),
): TicketSlaState {
  if (ticket.status === "resolved" || ticket.status === "closed") {
    return { kind: "none", dueAt: null, label: "—" };
  }

  const created = new Date(ticket.createdAt);
  const dueAt = new Date(created.getTime() + TICKET_SLA_BUDGET_MS[ticket.priority]);

  if (ticket.status === "waiting_on_user") {
    return { kind: "paused", dueAt, label: "Paused" };
  }

  const remaining = dueAt.getTime() - now.getTime();
  if (remaining <= 0) {
    return { kind: "breached", dueAt, label: "Overdue" };
  }
  return { kind: "ok", dueAt, label: formatSlaRemaining(remaining) };
}
```

- [ ] **Step 4: Run — expect PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-sla.test.ts --run
```

- [ ] **Step 5: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/lib/ticket-sla.ts web/src/lib/ticket-sla.test.ts
git commit -m @"
feat(spec 33): add pure ticket SLA helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: KPI strip — SLA Breached

**Files:**
- Modify: `web/src/lib/ticket-ui.ts`
- Modify: `web/src/lib/ticket-ui.test.ts`
- Modify: `web/src/components/ticket-kpi-strip.tsx`

**Interfaces:**
- Consumes: `ticketSlaState` from `@/lib/ticket-sla`
- Produces: `ticketKpiCounts` return shape gains `slaBreached: number`; rows need `createdAt` + `priority` + `status`

- [ ] **Step 1: Update failing KPI test**

In `web/src/lib/ticket-ui.test.ts`, replace the KPI test with:

```ts
it("counts KPI buckets including SLA breached", () => {
  const now = new Date("2026-10-21T18:00:00.000Z");
  expect(
    ticketKpiCounts(
      [
        {
          status: "open",
          priority: "high",
          createdAt: "2026-10-21T12:00:00.000Z", // due 16:00 → breached
        },
        {
          status: "open",
          priority: "high",
          createdAt: "2026-10-21T16:00:00.000Z", // due 20:00 → ok
        },
        {
          status: "in_progress",
          priority: "medium",
          createdAt: "2026-10-21T12:00:00.000Z",
        },
        {
          status: "waiting_on_user",
          priority: "high",
          createdAt: "2026-10-20T00:00:00.000Z", // paused, not breached
        },
        {
          status: "resolved",
          priority: "high",
          createdAt: "2026-10-20T00:00:00.000Z",
        },
        {
          status: "resolved",
          priority: "low",
          createdAt: "2026-10-20T00:00:00.000Z",
        },
        {
          status: "closed",
          priority: "high",
          createdAt: "2026-10-20T00:00:00.000Z",
        },
      ],
      now,
    ),
  ).toEqual({
    open: 2,
    inProgress: 1,
    waiting: 1,
    resolved: 2,
    slaBreached: 1,
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (missing `slaBreached` / signature)

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-ui.test.ts --run
```

- [ ] **Step 3: Implement KPI + strip**

Replace `ticketKpiCounts` in `web/src/lib/ticket-ui.ts`:

```ts
import type { TicketPriority, TicketStatus } from "@/lib/data";
import { ticketSlaState } from "@/lib/ticket-sla";

export function ticketKpiCounts(
  rows: {
    status: TicketStatus;
    priority: TicketPriority;
    createdAt: string;
  }[],
  now: Date = new Date(),
): {
  open: number;
  inProgress: number;
  waiting: number;
  resolved: number;
  slaBreached: number;
} {
  const out = {
    open: 0,
    inProgress: 0,
    waiting: 0,
    resolved: 0,
    slaBreached: 0,
  };
  for (const r of rows) {
    if (r.status === "open") out.open += 1;
    else if (r.status === "in_progress") out.inProgress += 1;
    else if (r.status === "waiting_on_user") out.waiting += 1;
    else if (r.status === "resolved") out.resolved += 1;
    if (ticketSlaState(r, now).kind === "breached") out.slaBreached += 1;
  }
  return out;
}
```

Keep the existing `import type { TicketPriority, TicketStatus }` — merge with current file imports (file already imports those types). Add the `ticket-sla` import; do not duplicate the type import line.

Update `web/src/components/ticket-kpi-strip.tsx`:

```tsx
"use client";

import { ticketKpiCounts } from "@/lib/ticket-ui";
import type { TicketListItem } from "@/lib/data";
import { cn } from "@/lib/utils";

export function TicketKpiStrip({ tickets }: { tickets: TicketListItem[] }) {
  const c = ticketKpiCounts(tickets);
  const cards = [
    { label: "Open", value: c.open, accent: "text-blue-600" },
    { label: "In Progress", value: c.inProgress, accent: "text-sky-600" },
    { label: "Waiting", value: c.waiting, accent: "text-amber-600" },
    { label: "Resolved", value: c.resolved, accent: "text-emerald-600" },
    { label: "SLA Breached", value: c.slaBreached, accent: "text-red-600" },
  ] as const;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-xl border bg-card px-4 py-3 shadow-sm"
        >
          <p className="text-muted-foreground text-xs font-medium">{card.label}</p>
          <p className={cn("mt-1 text-2xl font-semibold tracking-tight", card.accent)}>
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-ui.test.ts src/lib/ticket-sla.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/lib/ticket-ui.ts web/src/lib/ticket-ui.test.ts web/src/components/ticket-kpi-strip.tsx
git commit -m @"
feat(spec 33): add SLA Breached KPI card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: List + detail SLA display

**Files:**
- Modify: `web/src/components/tickets-view.tsx`
- Modify: `web/src/components/ticket-workspace.tsx`

**Interfaces:**
- Consumes: `ticketSlaState` → `.label` / `.kind`

- [ ] **Step 1: List column**

In `tickets-view.tsx`:

1. Import `ticketSlaState` from `@/lib/ticket-sla`.
2. In the table header, after Status, add `<TableHead>SLA</TableHead>`.
3. In each row, after the Status cell, add:

```tsx
                      <TableCell className="text-sm">
                        {(() => {
                          const sla = ticketSlaState(t);
                          return (
                            <span
                              className={
                                sla.kind === "breached"
                                  ? "text-destructive font-medium"
                                  : sla.kind === "paused"
                                    ? "text-muted-foreground"
                                    : undefined
                              }
                            >
                              {sla.label}
                            </span>
                          );
                        })()}
                      </TableCell>
```

Prefer extracting a tiny inline helper in the same file to avoid IIFE if cleaner:

```tsx
function SlaCell({ ticket }: { ticket: TicketListItem }) {
  const sla = ticketSlaState(ticket);
  return (
    <span
      className={
        sla.kind === "breached"
          ? "text-destructive font-medium"
          : sla.kind === "paused"
            ? "text-muted-foreground"
            : undefined
      }
    >
      {sla.label}
    </span>
  );
}
```

Use `<SlaCell ticket={t} />` in the row.

- [ ] **Step 2: Detail meta row**

In `ticket-workspace.tsx`, import `ticketSlaState` and `Timer` (or `Clock`) from `lucide-react` if not already imported. After the Status `MetaRow` (or after Priority), add:

```tsx
                <MetaRow icon={Clock} label="SLA">
                  {ticketSlaState({
                    createdAt: ticket.createdAt,
                    priority,
                    status,
                  }).label}
                </MetaRow>
```

Use live `status` / `priority` state so the label updates before save when the tech changes selects (matches retarget-on-priority-change).

- [ ] **Step 3: Smoke mentally / typecheck via tests**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-sla.test.ts src/lib/ticket-ui.test.ts --run
```

- [ ] **Step 4: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/components/tickets-view.tsx web/src/components/ticket-workspace.tsx
git commit -m @"
feat(spec 33): show SLA on ticket list and detail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: CSV SLA column + docs

**Files:**
- Modify: `web/src/lib/ticket-csv.ts`
- Modify: `web/src/lib/ticket-csv.test.ts`
- Modify: `docs/specs/33-ticketing/index.md`
- Modify: `PROGRESS.md`
- Modify: `docs/superpowers/specs/2026-10-21-ticket-simple-sla-design.md`

**Interfaces:**
- `ticketsToCsv(rows, now?: Date)` so tests stay deterministic

- [ ] **Step 1: Update CSV tests (fail first)**

Change header expectation to insert `SLA` after `Status`:

```ts
"Ticket ID,Subject,Asset,Location,Category,Priority,Status,SLA,Assignee,Requester,Created"
```

For the waiting_on_user row, expect `...,Waiting on user,Paused,...`.

For the empty-asset open/medium row, pass a fixed `now` so SLA is stable — e.g. createdAt `2026-10-21T16:04:00.000Z`, now `2026-10-21T17:04:00.000Z` → medium budget 8h → `7h left`:

Update the call signature in tests:

```ts
ticketsToCsv(rows, new Date("2026-10-21T17:04:00.000Z"))
```

Adjust each expectation’s SLA cell accordingly. For the 12-row pagination test, pass the same fixed `now`.

- [ ] **Step 2: Run — expect FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-csv.test.ts --run
```

- [ ] **Step 3: Implement CSV**

```ts
import { ticketSlaState } from "@/lib/ticket-sla";

const HEADERS = [
  "Ticket ID",
  "Subject",
  "Asset",
  "Location",
  "Category",
  "Priority",
  "Status",
  "SLA",
  "Assignee",
  "Requester",
  "Created",
] as const;

function ticketCsvCells(t: TicketListItem, now: Date): string[] {
  return [
    ticketNumberLabel(t.number),
    t.subject,
    t.assetTag ?? "",
    t.locationLabel ?? "",
    categoryLabel(t.category),
    TICKET_PRIORITY_LABEL[t.priority],
    TICKET_STATUS_LABEL[t.status],
    ticketSlaState(t, now).label,
    t.assigneeEmail ?? "",
    requesterLabel(t),
    t.createdAt,
  ];
}

export function ticketsToCsv(
  rows: TicketListItem[],
  now: Date = new Date(),
): string {
  const lines = [HEADERS.map((h) => csvField(h)).join(",")];
  for (const t of rows) {
    lines.push(ticketCsvCells(t, now).map(csvField).join(","));
  }
  return lines.join("\r\n");
}
```

Callers in `tickets-view` keep `ticketsToCsv(filtered)` (default now).

- [ ] **Step 4: Docs**

Spec 33 phases item 2 — mark simple SLA shipped; still open: per-alert-rule override.

PROGRESS — newest entry for `feat/spec-33-simple-sla`.

Design header Status → `Accepted (implemented on feat/spec-33-simple-sla)`.

Optionally one-line Summary note that v2 shipped CSV + simple SLA (AI/escalation still parked) — nice-to-have, do it if touching the Summary anyway.

- [ ] **Step 5: Run all related tests**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-sla.test.ts src/lib/ticket-ui.test.ts src/lib/ticket-csv.test.ts --run
```

- [ ] **Step 6: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/lib/ticket-csv.ts web/src/lib/ticket-csv.test.ts docs/specs/33-ticketing/index.md PROGRESS.md docs/superpowers/specs/2026-10-21-ticket-simple-sla-design.md
git commit -m @"
feat(spec 33): export SLA column and document simple SLA

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

## Spec coverage

| AC | Task |
|---|---|
| AC-S1 list labels | Task 1 + 3 |
| AC-S2 breach KPI | Task 2 |
| AC-S3 detail | Task 3 |
| AC-S4 CSV | Task 4 |
| AC-S5 no DB | All (no schema) |
| AC-S6 no escalation | All |

## Placeholder scan

None.

## Type consistency

`ticketSlaState` / `formatSlaRemaining` / `TICKET_SLA_BUDGET_MS` as Task 1. `ticketKpiCounts(..., now?)` gains `slaBreached`. `ticketsToCsv(rows, now?)` gains SLA cell.
