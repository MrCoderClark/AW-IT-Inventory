# Spec 33 v2 — Simple ticket SLA (compute + soft pause)

**Date**: 2026-10-21  
**Status**: Accepted (implemented on `feat/spec-33-simple-sla`)  
**Parent**: [Spec 33 ticketing](../../specs/33-ticketing/index.md)  
**Branch**: `feat/spec-33-simple-sla`  
**UI reference**: SLA column + “SLA Breached” KPI on [`docs/Design/ticketing-mock.png`](../../Design/ticketing-mock.png)  
**Prior v2**: [CSV export](./2026-10-21-ticket-csv-export-design.md) (shipped)

## Goal

Add **simple wall-clock SLA** from ticket priority: remaining/overdue labels on
the list and detail, a **SLA Breached** KPI card, and an SLA column on CSV
export. Soft-pause while Waiting on user. No escalation, no DB clock columns.

## Locked decisions

| Topic | Choice |
|---|---|
| Clock | Pure compute from `createdAt` + priority budget (no schema) |
| Budgets | High **4h**, Medium **8h**, Low **24h** (wall clock) |
| Pause | **Soft**: status `waiting_on_user` → label **Paused**; never breached while waiting; due does **not** extend when work resumes |
| Terminal | `resolved` / `closed` → display **—** (no frozen met/breached) |
| Priority change | Retarget immediately (same `createdAt`, new budget) |
| Escalation / business hours / admin budgets | Out of scope |
| KPI deltas (“vs yesterday”) | Out of scope |

## State machine (pure)

Given ticket `{ createdAt, priority, status }` and `now`:

1. If `status` ∈ {`resolved`, `closed`} → kind **`none`**, label `—`
2. Else if `status === waiting_on_user` → kind **`paused`**, label `Paused`
3. Else let `dueAt = createdAt + budget(priority)`:
   - If `now > dueAt` → kind **`breached`**, label `Overdue`
   - Else → kind **`ok`**, label like `3h left` / `45m left` (human remaining)

**Breached for KPI:** kind === `breached` only (excludes paused and terminal).

## UI

### List (`/tickets`)

- KPI strip: five cards — Open · In Progress · Waiting · Resolved · **SLA Breached**.
  Layout: responsive grid (e.g. `sm:grid-cols-2 lg:grid-cols-5` or wrap).
- Table: add **SLA** column (after Status or before Location — prefer after Status).
- Badge/text styling: Overdue destructive/amber emphasis; Paused muted; remaining muted/default.

### Detail (`/tickets/[id]`)

- Meta sidebar (or header meta): **SLA** row with the same label as the list.
- No escalation progress bar / “escalates to …” block.

### CSV

- Append column **SLA** after Status (or at end before Created — prefer after Status)
  using the same format helper at export time (`now = Date.now()`).

## Implementation sketch

1. **`web/src/lib/ticket-sla.ts`** (+ `ticket-sla.test.ts`)
   - `TICKET_SLA_BUDGET_MS: Record<TicketPriority, number>`
   - `ticketSlaState(ticket, now): { kind; dueAt: Date | null; label: string }`
   - `ticketSlaBreached(ticket, now): boolean` (or derive from kind)
   - `formatSlaRemaining(ms): string` for “Xh left” / “Ym left”
2. **`ticketKpiCounts`** — add `slaBreached` using the breach predicate over the
   loaded set (pass `now` or use `Date.now()` inside strip).
3. **`ticket-kpi-strip.tsx`** — fifth card.
4. **`tickets-view.tsx`** — SLA column; **`ticket-workspace.tsx`** — SLA meta.
5. **`ticket-csv.ts`** — SLA column + tests updated.
6. Docs: Spec 33 phases; `PROGRESS.md`; this design Status → implemented when shipped.

## Acceptance criteria

- **AC-S1**: List shows SLA labels per state machine for open / in_progress /
  waiting / resolved / closed.
- **AC-S2**: SLA Breached KPI counts only breached (not paused, not terminal).
- **AC-S3**: Detail page shows the same SLA label for the ticket.
- **AC-S4**: CSV includes an SLA column consistent with list formatting.
- **AC-S5**: No new DB columns / no `db:push` required.
- **AC-S6**: No escalation UI or business-hours logic.

## Out of scope

- True pause (accumulate waiting time)
- Escalation assignee / timers
- Admin-editable SLA policies
- Server-side SLA jobs / email on breach
- Per-alert-rule auto-create override (next v2 slice)

## Self-review

- No placeholders for budgets or labels.
- Soft pause matches locked decision (due does not extend).
- Does not reintroduce AI triage or fake trend deltas.
- CSV change is additive and scoped.
