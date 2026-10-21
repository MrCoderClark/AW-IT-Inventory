# 33. Ticketing / helpdesk — internal IT work tracking

> Fifth RMM-core capability after the [roadmap](../28-rmm-roadmap/index.md)
> (decision **A**). Builds on [spec 19](../19-notifications/index.md) notifications
> and inventory assets/people. Optional AI ticket-draft assist stays in
> [spec 34](../34-ai-assisted-ops/index.md) (later).

**Date**: 2026-10-20  
**Status**: Accepted (v1 merged) — [design v1](./design-v1.md) · [plan v1](./plan-v1.md)  
**UI polish (Accepted)**: [helpdesk list + full detail](../../superpowers/specs/2026-10-20-ticketing-helpdesk-ui-design.md)  
**UI references**: helpdesk mock (user) · [`docs/Design/ticketing-mock.png`](../../Design/ticketing-mock.png)

## Summary

H2Tecs gains an **internal IT ticketing** module: admins track work items linked
to assets and notifications, with status, priority, assignee, and a comment
thread. Technicians can **create a ticket from a notification**, and admins can
configure which **notification types auto-open** a ticket when that notification
is created.

v1 is **IT staff only** (`user:admin`). No end-user portal, email-in, or SLA
clocks. The mock’s AI triage / SLA / export chrome is the visual north star for
layout; those features are parked for later phases.

## Principles

- **Work items ≠ bell.** Notifications remain the live ops feed; tickets are
  durable work with ownership and history.
- **Human control.** Auto-create is opt-in per notification type; manual create
  always available. Never fail an alert because ticket insert failed.
- **Reuse inventory identity.** Optional `asset_id`; assignees are emails
  (aw-auth users), same pattern as other `requestedBy` / actor fields.
- **Mock-guided UI, scope-honest.** Helpdesk list dashboard at `/tickets` and
  full detail page at `/tickets/[id]`; no fake SLA or AI blocks in v1.

## Requirements

**User stories**:
- As an IT admin, I want a Tickets page to open, assign, and close work tied to
  a computer or alert so follow-ups don’t live only in the bell.
- As an IT admin, I want “Create ticket” on a notification so context is
  prefilled and we don’t duplicate work.
- As an IT admin, I want certain alert types to open a ticket automatically so
  high-severity events aren’t missed, without forcing that for every type.

### Acceptance criteria (v1)

- **AC-1**: `tickets` and `ticket_comments` (or equivalent) live in the web DB.
  Ticket fields: display id, subject, description, status
  (`open` | `in_progress` | `resolved` | `closed`), priority
  (`low` | `medium` | `high`), category (short text), assignee email (nullable),
  optional `asset_id`, optional unique `source_notification_id`, `created_by`,
  timestamps.
- **AC-2**: Comments support user and system kinds (e.g. “Ticket created from
  notification”) on a per-ticket thread.
- **AC-3**: Admins (`user:admin`) can list, create, update (status / priority /
  assignee / subject / description / category / asset), and comment. Non-admins
  cannot access `/tickets` or ticket mutations.
- **AC-4**: Manual **New Ticket** and **Create ticket from notification**
  (prefill from notification title/body/asset; set `source_notification_id`).
  Creating again for the same notification is a no-op or returns the existing
  ticket (dedupe).
- **AC-5**: Admin settings list Spec 19 `NotificationType`s with toggles for
  **auto-create ticket**. On successful `createNotification`, if the type is
  enabled and no ticket exists for that notification id, insert a ticket
  best-effort (never fails the notification path).
- **AC-6**: UI at `/tickets` is a helpdesk list (KPI strip + table with search
  and filters for status/priority/category/assignee); detail at `/tickets/[id]`
  (conversation + meta sidebar). UI polish omits SLA, AI, Export, Tags, and
  Related tickets.
- **AC-7**: Nav **Ticketing** under Manage, gated `user:admin`. Deep-link from
  ticket to asset when linked; from notification to ticket when one exists.

## Decision

**First-class tickets in the web inventory DB**, not a stretch of Spec 19 and
not an external helpdesk webhook. Auto-create is a **global type matrix**
(admin settings), not per Spec 30 alert rule in v1. RBAC reuses **`user:admin`**
(no new permission in v1).

## Statuses

`open` · `in_progress` · `waiting_on_user` · `resolved` · `closed`

List KPI strip: **Open / In Progress / Waiting / Resolved** (`waiting` =
`waiting_on_user`; `closed` stays available on the ticket but is not a KPI card).

## Phases

1. **v1 (this spec)** — AC-1–7: schema, CRUD, comments, manual + auto from
   notifications, `/tickets` UI (mock-guided, SLA/AI stripped), admin type
   toggles.
2. **v2** — waiting status; CSV export; simple SLA; **per-alert-rule ticket
   auto-create override** (shipped).
3. **Later** — email-in; end-user portal; Spec 34 ticket-draft assist.

## Out of scope / non-goals (v1)

- Email-in / outbound ticket email threads.
- SLA clocks, escalation, “SLA Breached” KPIs.
- AI triage / auto-triage / confidence UI.
- End-user self-service.
- New RBAC permission (`ticket:write`).
- Billing / MSP multi-tenant PSA (roadmap fork B).

## Related

- [28](../28-rmm-roadmap/index.md) · [19](../19-notifications/index.md) ·
  [30](../30-alert-rules/index.md) · [34](../34-ai-assisted-ops/index.md) ·
  [16](../16-people-directory-assignments/index.md)
