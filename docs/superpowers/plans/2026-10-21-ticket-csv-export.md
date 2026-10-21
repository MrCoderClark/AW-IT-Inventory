# Ticket list CSV export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Export button on `/tickets` that downloads the current filtered ticket set as CSV.

**Architecture:** Pure `ticketsToCsv` builder (same RFC 4180 + BOM pattern as `assetsToCsv`), wired from `TicketsView` against the already-computed `filtered` array so pagination does not shrink the file.

**Tech Stack:** Next.js 16 client component, Vitest, existing `ticket-ui` labels, sonner toasts (same as asset Export).

**Spec:** [`docs/superpowers/specs/2026-10-21-ticket-csv-export-design.md`](../specs/2026-10-21-ticket-csv-export-design.md)

## Global Constraints

- Client-side only; no new API route
- Export **filtered** rows, not page slice (`PAGE = 10` stays UI-only)
- Columns fixed: Ticket ID, Subject, Asset, Location, Category, Priority, Status, Assignee, Requester, Created
- Human status/priority labels including `waiting_on_user` → `Waiting on user`
- Filename `opus-tickets-YYYY-MM-DD.csv`
- UTF-8 BOM + CRLF
- Description body omitted
- No SLA columns
- RBAC unchanged (`user:admin` on `/tickets`)
- Shell is PowerShell; quote paths with `(app)` if needed
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File structure

| File | Role |
|---|---|
| `web/src/lib/ticket-csv.ts` | Pure CSV builder + field escaping |
| `web/src/lib/ticket-csv.test.ts` | Unit tests for builder |
| `web/src/components/tickets-view.tsx` | Export button + download |
| `docs/specs/33-ticketing/index.md` | Note CSV export under v2 |
| `PROGRESS.md` | Ship note |

---

### Task 1: `ticketsToCsv` helper

**Files:**
- Create: `web/src/lib/ticket-csv.ts`
- Create: `web/src/lib/ticket-csv.test.ts`

**Interfaces:**
- Consumes: `TicketListItem` from `@/lib/data`; `ticketNumberLabel`, `categoryLabel`, `TICKET_STATUS_LABEL`, `TICKET_PRIORITY_LABEL`, `requesterLabel` from `@/lib/ticket-ui`
- Produces: `ticketsToCsv(rows: TicketListItem[]): string`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/ticket-csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { TicketListItem } from "@/lib/data";
import { ticketsToCsv } from "@/lib/ticket-csv";

function row(partial: Partial<TicketListItem> & Pick<TicketListItem, "number" | "subject">): TicketListItem {
  return {
    id: partial.id ?? "id-1",
    number: partial.number,
    subject: partial.subject,
    description: partial.description ?? "",
    status: partial.status ?? "open",
    priority: partial.priority ?? "medium",
    category: partial.category ?? "Hardware",
    assigneeEmail: partial.assigneeEmail ?? null,
    requesterEmail: partial.requesterEmail ?? null,
    assetId: partial.assetId ?? null,
    assetTag: partial.assetTag ?? null,
    assetName: partial.assetName ?? null,
    locationLabel: partial.locationLabel ?? null,
    sourceNotificationId: partial.sourceNotificationId ?? null,
    createdBy: partial.createdBy ?? "admin@example.com",
    createdAt: partial.createdAt ?? "2026-10-21T16:04:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-10-21T16:04:00.000Z",
  };
}

describe("ticketsToCsv", () => {
  it("emits header and one data row with human labels", () => {
    const csv = ticketsToCsv([
      row({
        number: 1042,
        subject: "Disk low",
        status: "waiting_on_user",
        priority: "high",
        category: "Alert",
        assetTag: "7192FK2",
        locationLabel: "NYC",
        assigneeEmail: "jc@example.com",
        requesterEmail: "user@example.com",
        createdAt: "2026-10-21T16:04:00.000Z",
      }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Ticket ID,Subject,Asset,Location,Category,Priority,Status,Assignee,Requester,Created",
    );
    expect(lines[1]).toBe(
      "TKT-1042,Disk low,7192FK2,NYC,Alert,High,Waiting on user,jc@example.com,user,2026-10-21T16:04:00.000Z",
    );
  });

  it("escapes commas and quotes per RFC 4180", () => {
    const csv = ticketsToCsv([
      row({
        number: 1,
        subject: 'Say "hello", world',
      }),
    ]);
    expect(csv.split("\r\n")[1]).toContain('"Say ""hello"", world"');
  });

  it("exports every filtered row even when more than one page worth", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ number: i + 1, subject: `T${i + 1}`, id: `id-${i + 1}` }),
    );
    const lines = ticketsToCsv(rows).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(13); // header + 12
  });

  it("uses empty cells for missing asset/assignee/location", () => {
    const line = ticketsToCsv([
      row({ number: 2, subject: "No asset", createdBy: "admin@example.com" }),
    ]).split("\r\n")[1];
    // Asset, Location empty; Assignee empty; Requester from createdBy → "admin"
    expect(line).toBe(
      "TKT-2,No asset,,,Hardware,Medium,Open,,admin,2026-10-21T16:04:00.000Z",
    );
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-csv.test.ts --run
```

Expected: FAIL — cannot find module `@/lib/ticket-csv` / `ticketsToCsv` not exported.

- [ ] **Step 3: Implement `ticketsToCsv`**

Create `web/src/lib/ticket-csv.ts`:

```ts
import type { TicketListItem } from "@/lib/data";
import {
  categoryLabel,
  requesterLabel,
  ticketNumberLabel,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
} from "@/lib/ticket-ui";

const HEADERS = [
  "Ticket ID",
  "Subject",
  "Asset",
  "Location",
  "Category",
  "Priority",
  "Status",
  "Assignee",
  "Requester",
  "Created",
] as const;

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function ticketCsvCells(t: TicketListItem): string[] {
  return [
    ticketNumberLabel(t.number),
    t.subject,
    t.assetTag ?? "",
    t.locationLabel ?? "",
    categoryLabel(t.category),
    TICKET_PRIORITY_LABEL[t.priority],
    TICKET_STATUS_LABEL[t.status],
    t.assigneeEmail ?? "",
    requesterLabel(t),
    t.createdAt,
  ];
}

/** RFC 4180 CSV for ticket list export (spec 33 v2). Caller passes filtered rows. */
export function ticketsToCsv(rows: TicketListItem[]): string {
  const lines = [HEADERS.map((h) => csvField(h)).join(",")];
  for (const t of rows) {
    lines.push(ticketCsvCells(t).map(csvField).join(","));
  }
  return lines.join("\r\n");
}
```

- [ ] **Step 4: Run test — expect PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-csv.test.ts --run
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/lib/ticket-csv.ts web/src/lib/ticket-csv.test.ts
git commit -m @"
feat(spec 33): add ticketsToCsv for list export

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: Export button on `TicketsView`

**Files:**
- Modify: `web/src/components/tickets-view.tsx`

**Interfaces:**
- Consumes: `ticketsToCsv` from `@/lib/ticket-csv`; existing `filtered` memo
- Produces: Export control in list header

- [ ] **Step 1: Wire Export beside New Ticket**

In `web/src/components/tickets-view.tsx`:

1. Add imports:

```ts
import { Download, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { ticketsToCsv } from "@/lib/ticket-csv";
```

2. Add handler inside `TicketsView` (after `onTicketCreated`):

```ts
  function exportCsv() {
    if (filtered.length === 0) {
      toast.error("Nothing to export", {
        description: "No tickets match the current filters.",
      });
      return;
    }
    const csv = ticketsToCsv(filtered);
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `opus-tickets-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success("Export ready", {
      description: `${filtered.length} ticket${filtered.length === 1 ? "" : "s"} exported to CSV.`,
    });
  }
```

3. Replace the single New Ticket button cluster with:

```tsx
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={filtered.length === 0}
              onClick={exportCsv}
            >
              <Download className="size-4" />
              Export
            </Button>
            <Button type="button" onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" />
              New Ticket
            </Button>
          </div>
```

Use literal BOM `\uFEFF` (not a magic invisible character) so the source stays reviewable.

- [ ] **Step 2: Manual smoke (dev server if already running)**

Open `/tickets` as admin: Export downloads filtered rows; with a filter that matches nothing, button is disabled.

- [ ] **Step 3: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/components/tickets-view.tsx
git commit -m @"
feat(spec 33): wire tickets list CSV Export button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Docs + PROGRESS

**Files:**
- Modify: `docs/specs/33-ticketing/index.md`
- Modify: `PROGRESS.md`
- Modify: `docs/superpowers/specs/2026-10-21-ticket-csv-export-design.md` (Status → implemented)

- [ ] **Step 1: Update Spec 33 phases**

In `docs/specs/33-ticketing/index.md`, under Phases item 2, change the still-open list so CSV export is marked shipped, e.g.:

```md
2. **v2 (partial)** — `waiting_on_user` + Waiting KPI (shipped); **CSV list
   export** (shipped). Still open: SLA timers / breach KPIs; per-alert-rule
   auto-create override.
```

- [ ] **Step 2: PROGRESS entry (newest first)**

At top of `PROGRESS.md` after the legend separator, add:

```md
## 🚧 Ticketing: CSV list export (spec 33 v2, `feat/spec-33-ticket-csv-export`)

Export button on `/tickets` downloads the current filtered ticket set as
`opus-tickets-YYYY-MM-DD.csv` (client-side, asset-export pattern). No SLA
columns. Design: `docs/superpowers/specs/2026-10-21-ticket-csv-export-design.md`.
```

- [ ] **Step 3: Mark design Status implemented**

In the design doc header: `**Status**: Accepted (implemented on feat/spec-33-ticket-csv-export)`

- [ ] **Step 4: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add docs/specs/33-ticketing/index.md PROGRESS.md docs/superpowers/specs/2026-10-21-ticket-csv-export-design.md
git commit -m @"
docs(spec 33): mark ticket CSV export in Spec 33 v2

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

## Spec coverage (self-review)

| Spec AC | Task |
|---|---|
| AC-E1 Export filtered list | Task 2 |
| AC-E2 Columns + human labels | Task 1 |
| AC-E3 Pagination does not limit export | Task 1 (12-row test) + Task 2 uses `filtered` |
| AC-E4 Empty → disabled / no garbage file | Task 2 `disabled` + toast guard |
| AC-E5 RBAC unchanged | No auth changes |
| No description / no SLA | Task 1 column list |

## Placeholder scan

None (no TBD / “similar to”).

## Type consistency

`ticketsToCsv(rows: TicketListItem[]): string` — Task 1 produces, Task 2 consumes. Requester cell uses `requesterLabel` (local-part), matching the design’s “same display rule as UI”.
