# Ticketing Helpdesk UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tickets list+side-pane with a helpdesk-style `/tickets` dashboard and full `/tickets/[id]` workspace matching the approved America Works–style mock.

**Architecture:** Keep Spec 33 data/actions. Extend list/get joins with asset location name. Rewrite `TicketsView` as list-only (KPI strip, richer table, pagination). Add RSC `/tickets/[id]` + client `TicketWorkspace` (conversation tabs + right meta). Retarget notification deep links from `?id=` to `/tickets/[id]`.

**Tech Stack:** Next.js 16 App Router, Drizzle, Vitest, existing `Tabs` (`TabsTab`/`TabsPanel`), shadcn Badge/Button/Table, Spec 33 ticket actions.

**Design:** [2026-10-20-ticketing-helpdesk-ui-design.md](../specs/2026-10-20-ticketing-helpdesk-ui-design.md)

## Global Constraints

- Branch from `main` as `feat/spec-33-ticketing-helpdesk-ui` before application code; never commit feature code on `main`.
- `user:admin` only; no new RBAC permission.
- No SLA, AI triage, Export, Tags, Related tickets, Critical priority, or real On Hold status.
- KPI “On Hold” slot = **Closed** count; no % / vs-prior deltas.
- Pagination page size **10** (client-side).
- Location = linked asset’s `locations.name` (or —); Assignee remains a list filter (not Location filter).
- User runs servers / `db:push` if needed; agent provides commands. No schema migration required if only joining existing tables.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Shell is PowerShell; quote paths containing `(app)`.

---

## File map

| File | Responsibility |
|---|---|
| `web/src/lib/data.ts` | Add `locationLabel` to `TicketListItem` |
| `web/src/db/tickets.ts` | Join `locations`; map `locationLabel`; keep CRUD |
| `web/src/lib/ticket-ui.ts` | KPI helper; stronger badge variants |
| `web/src/lib/ticket-ui.test.ts` | KPI + label tests |
| `web/src/db/tickets.test.ts` | Assert location mapping if mocked select includes it |
| `web/src/components/tickets-view.tsx` | List-only: KPIs, filters, table, pagination |
| `web/src/components/ticket-kpi-strip.tsx` | Four KPI cards |
| `web/src/components/ticket-workspace.tsx` | Full detail shell |
| `web/src/app/(app)/tickets/[id]/page.tsx` | Auth + load + workspace |
| `web/src/components/ticket-detail-pane.tsx` | Delete after workspace owns UI |
| `web/src/components/notifications-view.tsx` | Links → `/tickets/[id]` |
| `web/src/app/(app)/ticket-actions.ts` | Also `revalidatePath` detail |
| `docs/specs/33-ticketing/index.md` | AC-6 / principles → list + full page |
| `docs/superpowers/specs/2026-10-20-ticketing-helpdesk-ui-design.md` | Status → Accepted |

---

### Task 1: Branch + `locationLabel` + KPI helper

**Files:**
- Create branch `feat/spec-33-ticketing-helpdesk-ui`
- Modify: `web/src/lib/data.ts` (`TicketListItem`)
- Modify: `web/src/db/tickets.ts` (`toListItem`, `listTickets`, `getTicket` selects — leftJoin locations)
- Modify: `web/src/lib/ticket-ui.ts`
- Modify: `web/src/lib/ticket-ui.test.ts`
- Test: `web/src/lib/ticket-ui.test.ts`

**Interfaces:**
- Produces: `TicketListItem.locationLabel: string | null`
- Produces: `ticketKpiCounts(tickets: { status: TicketStatus }[]): { open: number; inProgress: number; closed: number; resolved: number }`

- [ ] **Step 1: Create branch**

```powershell
cd D:\Code\aw\aw-inventory
git checkout main
git pull
git checkout -b feat/spec-33-ticketing-helpdesk-ui
```

- [ ] **Step 2: Write failing KPI tests**

Append to `web/src/lib/ticket-ui.test.ts`:

```ts
import { ticketKpiCounts } from "@/lib/ticket-ui";

it("counts KPI buckets", () => {
  expect(
    ticketKpiCounts([
      { status: "open" },
      { status: "open" },
      { status: "in_progress" },
      { status: "closed" },
      { status: "resolved" },
      { status: "resolved" },
    ]),
  ).toEqual({ open: 2, inProgress: 1, closed: 1, resolved: 2 });
});
```

- [ ] **Step 3: Run test — expect FAIL**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-ui.test.ts
```

Expected: FAIL — `ticketKpiCounts` not exported / not defined.

- [ ] **Step 4: Implement helper + `locationLabel` plumbing**

In `web/src/lib/ticket-ui.ts` add:

```ts
import type { TicketStatus } from "@/lib/data";

export function ticketKpiCounts(
  rows: { status: TicketStatus }[],
): { open: number; inProgress: number; closed: number; resolved: number } {
  const out = { open: 0, inProgress: 0, closed: 0, resolved: 0 };
  for (const r of rows) {
    if (r.status === "open") out.open += 1;
    else if (r.status === "in_progress") out.inProgress += 1;
    else if (r.status === "closed") out.closed += 1;
    else if (r.status === "resolved") out.resolved += 1;
  }
  return out;
}
```

In `web/src/lib/data.ts` add to `TicketListItem`:

```ts
locationLabel: string | null;
```

In `web/src/db/tickets.ts`:
- Import `locations` from schema (same file as `assets`).
- Extend `toListItem` input with `locationLabel?: string | null` and set `locationLabel: row.locationLabel ?? null`.
- In `listTickets` and `getTicket` select: `locationLabel: locations.name`.
- Chain `.leftJoin(locations, eq(assets.locationId, locations.id))` after the assets join.

- [ ] **Step 5: Run tests — expect PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/lib/ticket-ui.test.ts src/db/tickets.test.ts
```

Expected: PASS (existing tickets tests still pass).

- [ ] **Step 6: Commit**

```powershell
git add web/src/lib/data.ts web/src/lib/ticket-ui.ts web/src/lib/ticket-ui.test.ts web/src/db/tickets.ts
git commit -m "$(cat <<'EOF'
feat(spec 33): add ticket KPI counts and locationLabel join

EOF
)"
```

On PowerShell without bash heredoc, use:

```powershell
git commit -m "feat(spec 33): add ticket KPI counts and locationLabel join`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: List page — KPI strip + helpdesk table

**Files:**
- Create: `web/src/components/ticket-kpi-strip.tsx`
- Modify: `web/src/components/tickets-view.tsx` (remove detail pane; new columns; pagination)
- Modify: `web/src/app/(app)/tickets/page.tsx` (drop `searchParams` id if unused)
- Modify: `web/src/lib/ticket-ui.ts` — richer `ticketStatusVariant` / `ticketPriorityVariant` if needed for colored pills (high=destructive, open=default, resolved=outline ok; ensure medium/high readable)

**Interfaces:**
- Consumes: `ticketKpiCounts`, `TicketListItem.locationLabel`
- Produces: List navigates with `router.push(`/tickets/${id}`)`

- [ ] **Step 1: Add `TicketKpiStrip`**

Create `web/src/components/ticket-kpi-strip.tsx`:

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
    { label: "Closed", value: c.closed, accent: "text-amber-600" },
    { label: "Resolved", value: c.resolved, accent: "text-emerald-600" },
  ] as const;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

- [ ] **Step 2: Rewrite `TicketsView` list behavior**

In `web/src/components/tickets-view.tsx`:
- Remove `selectedId` / `detail` / `getTicketAction` / `TicketDetailPane` / URL `id` sync.
- Import `TicketKpiStrip`, `fmtDateTime` from detail-ui (or a short local date formatter already used elsewhere).
- After header, render `<TicketKpiStrip tickets={initialTickets} />`.
- Table columns: Ticket, Title, Requester (`assigneeLabel(createdBy)` or local email→local-part — use a small helper: for requester show local-part of `createdBy` same as `assigneeLabel`), Category, Priority, Status, Created, Updated, Location (`t.locationLabel ?? "—"`).
- `onClick` row: `router.push(`/tickets/${t.id}`)`.
- Pagination: `const PAGE = 10`; state `page` (0-based); slice `filtered`; reset page when filters change; footer with prev/next + page numbers.
- Keep filters + `NewTicketDialog`; on create success `router.push(`/tickets/${ticketId}`)` when id present.
- Drop unused `viewerEmail` prop if truly unused, or keep for future — if page still passes it, accept prop to avoid churn.

- [ ] **Step 3: Simplify `tickets/page.tsx`**

```tsx
export default async function TicketsPage() {
  const user = await requireUser();
  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Tickets"
        description="You don't have permission to manage tickets. Ask an administrator for the user:admin role."
        icon={Lock}
      />
    );
  }
  const tickets = await listTickets();
  return (
    <TicketsView initialTickets={tickets} viewerEmail={user.email} />
  );
}
```

Remove `searchParams` / `initialTicketId`.

- [ ] **Step 4: Manual smoke (user)**

With `npm run dev` running: open `/tickets` — KPI cards, table columns, no side pane; click row → detail URL (404 until Task 3 is fine if Task 3 next). Prefer finishing Task 3 before claiming list done if navigating 404s.

- [ ] **Step 5: Commit**

```powershell
git add web/src/components/ticket-kpi-strip.tsx web/src/components/tickets-view.tsx "web/src/app/(app)/tickets/page.tsx"
git commit -m "feat(spec 33): helpdesk tickets list with KPI strip`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Full ticket page (`/tickets/[id]`)

**Files:**
- Create: `web/src/app/(app)/tickets/[id]/page.tsx`
- Create: `web/src/components/ticket-workspace.tsx`
- Delete: `web/src/components/ticket-detail-pane.tsx` (after logic moved)
- Modify: `web/src/app/(app)/ticket-actions.ts` — `revalidatePath(\`/tickets/${id}\`)` alongside `/tickets`

**Interfaces:**
- Consumes: `getTicket(id)`, `updateTicketAction`, `addTicketCommentAction`
- Produces: `TicketWorkspace({ ticket })` client component

- [ ] **Step 1: Add detail page RSC**

Create `web/src/app/(app)/tickets/[id]/page.tsx` mirroring people detail gate:

```tsx
import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";
import { TicketWorkspace } from "@/components/ticket-workspace";
import { getTicket } from "@/db/tickets";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function TicketDetailPage({
  params,
}: PageProps<"/tickets/[id]">) {
  const user = await requireUser();
  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Ticket"
        description="You don't have permission to manage tickets. Ask an administrator for the user:admin role."
        icon={Lock}
      />
    );
  }
  const { id } = await params;
  const ticket = await getTicket(id);
  if (!ticket) notFound();
  return <TicketWorkspace ticket={ticket} />;
}
```

- [ ] **Step 2: Implement `TicketWorkspace`**

Create `web/src/components/ticket-workspace.tsx` (`"use client"`):

Structure:
1. Link `← Back to Tickets` → `/tickets`
2. Header: `Badge` priority + mono `#TKT-n`; `h1` subject; description paragraph; Created / Updated via `fmtDateTime`
3. Action bar: Status `Select`; Button “Add note” → focuses comment textarea ref; “Assign” toggles assignee `Input` visibility or always show compact assignee field; “Update” calls `updateTicketAction` when dirty
4. Main: `Tabs` default `conversation`
   - Conversation: filter `comments` where `kind === "user"`; message bubbles (initials from email); textarea + Send → `addTicketCommentAction`
   - Activity: `kind === "system"` list
   - Details: category, createdBy, link to `/notifications` or notification if you only have id — show `sourceNotificationId` truncated or “From alert” when set
   - Assets: if `assetTag`, card with Link to `/assets/${assetTag}` (match existing asset URL pattern used in old pane)
5. Right sidebar (`aside`, `lg:w-80`): Ticket details dl; Related asset card

Reuse toast + Loader2 patterns from deleted pane. Port state for status/priority/assigneeEmail from `ticket-detail-pane.tsx`.

- [ ] **Step 3: Wire revalidation**

In `ticket-actions.ts`, wherever `revalidatePath("/tickets")` runs after mutate, also:

```ts
revalidatePath(`/tickets/${id}`);
```

(use the ticket id in scope for update/comment/create-from-notification).

- [ ] **Step 4: Delete side pane**

Remove `web/src/components/ticket-detail-pane.tsx` and fix any remaining imports (should be none after Task 2).

- [ ] **Step 5: Run targeted tests**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/app/(app)/ticket-actions.test.ts src/lib/ticket-ui.test.ts
```

Expected: PASS (update revalidate expectations if tests assert exact `revalidatePath` call list — extend mocks to allow second path).

- [ ] **Step 6: Commit**

```powershell
git add "web/src/app/(app)/tickets/[id]/page.tsx" web/src/components/ticket-workspace.tsx "web/src/app/(app)/ticket-actions.ts" "web/src/app/(app)/ticket-actions.test.ts"
git rm web/src/components/ticket-detail-pane.tsx
git commit -m "feat(spec 33): full ticket detail workspace page`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Deep links + docs

**Files:**
- Modify: `web/src/components/notifications-view.tsx` — `router.push(`/tickets/${res.ticketId}`)` and `Link href={`/tickets/${ticketId}`}`
- Modify: `docs/specs/33-ticketing/index.md` — AC-6 and principles to list + full page; status note for UI polish
- Modify: `docs/superpowers/specs/2026-10-20-ticketing-helpdesk-ui-design.md` — Status: Accepted
- Grep for `tickets?id=` and fix any leftovers (`notification-bell`, etc.)

**Interfaces:**
- Consumes: ticket id strings from create actions

- [ ] **Step 1: Grep and retarget**

```powershell
cd D:\Code\aw\aw-inventory
rg "tickets\?id=" web/src
```

Replace with `/tickets/${id}` form.

- [ ] **Step 2: Update Spec 33 index**

Change AC-6 to: UI at `/tickets` is a helpdesk list (KPI strip + table); detail at `/tickets/[id]` (conversation + meta sidebar). v1/UI polish omits SLA, AI, Export, Tags, Related tickets.

Update Principles bullet that says “Master–detail list + pane”.

- [ ] **Step 3: Mark design Accepted**

Set status line on the helpdesk UI design doc to Accepted.

- [ ] **Step 4: Full web test pass**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test
```

Expected: PASS (or only pre-existing unrelated failures — note them).

- [ ] **Step 5: Commit**

```powershell
git add web/src/components/notifications-view.tsx docs/specs/33-ticketing/index.md docs/superpowers/specs/2026-10-20-ticketing-helpdesk-ui-design.md
git commit -m "docs(spec 33): retarget ticket links and accept helpdesk UI design`n`nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Spec coverage (self-review)

| Spec AC | Task |
|---|---|
| AC-UI-1 list no pane + KPIs + columns + navigate | Task 2 |
| AC-UI-2 detail structure | Task 3 |
| AC-UI-3 create / notif / deep links | Tasks 2–4 |
| AC-UI-4 CRUD + admin gate | Task 3 (reuse actions) |
| AC-UI-5 Closed for On Hold; no fake % | Tasks 1–2 |
| `locationLabel` | Task 1 |

## Manual smoke checklist (user)

1. `/tickets` — four KPIs, filters, table with Requester/Created/Updated/Location, pagination, Create Ticket.
2. Row → `/tickets/[id]` — back link, conversation, activity, assets, sidebar, Update / comment.
3. Notifications “Create ticket” → lands on detail page.
4. Non-admin still blocked.
