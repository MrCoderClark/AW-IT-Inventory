# Spec 33 v1 — Ticketing design

**Date**: 2026-10-20  
**Status**: Accepted (plan ready) — [plan](./plan-v1.md) · [index](./index.md)  
**UI mock**: [`docs/Design/ticketing-mock.png`](../../Design/ticketing-mock.png)

## Locked decisions

| Topic | Choice |
|---|---|
| Actors | IT staff only (`user:admin`) |
| Scope | Core tickets + comments + create from notification + auto-create |
| Auto-create control | Global admin toggles per Spec 19 `NotificationType` |
| Manual from notification | Yes (Create ticket action) |
| Architecture | First-class `tickets` in web DB |
| SLA / AI triage / email-in / end-user portal | Parked |
| RBAC | Reuse `user:admin` (no `ticket:write` in v1) |

## Mock → v1 mapping

| Mock element | v1 |
|---|---|
| Manage → Ticketing nav | Yes |
| Header + New Ticket | Yes |
| Search + Status / Priority / Category / Assignee filters | Yes |
| Table + right detail pane | Yes |
| SLA column / SLA KPIs / escalation | No (park) |
| Auto-triage toggle / AI Triage panel | No (park) |
| Export | No (park) |
| Waiting on User status | No — use `open` / `in_progress` / `resolved` / `closed` |
| Subtitle “AI-triaged…” | Reword without AI claim |

## Data model

### `tickets`

- `id` uuid PK  
- `number` int unique (monotonic display; UI shows `TKT-{number}` or similar)  
- `subject` text not null  
- `description` text not null default `''`  
- `status` text: `open` \| `in_progress` \| `resolved` \| `closed`  
- `priority` text: `low` \| `medium` \| `high`  
- `category` text not null default `''`  
- `assignee_email` text null  
- `asset_id` uuid null → assets (on delete set null)  
- `source_notification_id` uuid null unique → notifications (on delete set null)  
- `created_by` text not null  
- `created_at` / `updated_at` timestamptz  

Indexes: `(status, updated_at desc)`, `(asset_id)`, `(assignee_email)`.

### `ticket_comments`

- `id` uuid PK  
- `ticket_id` uuid → tickets cascade  
- `author_email` text not null  
- `body` text not null  
- `kind` text: `user` \| `system`  
- `created_at` timestamptz  

### Auto-create settings

Store enabled notification types for ticket auto-create (e.g. a
`ticket_auto_create_types` table of `type` text PK, or a single settings JSON
row). Default: **all types off** until an admin enables them (no surprise
tickets on day one).

## Flows

```
New Ticket (admin)
  → insert tickets + optional system comment

Notification → Create ticket
  → if source_notification_id already linked → return existing
  → else insert with prefilled subject/body/asset_id + system comment

createNotification (any path)
  → on successful insert
  → if type enabled for auto-create AND no ticket for this notification id
  → best-effort insert ticket + system comment
  → never throw into the notify caller
```

## UI surfaces

| Surface | Notes |
|---|---|
| `/tickets` | RSC list + client detail pane (mock layout) |
| New Ticket dialog | Subject, description, priority, category, asset picker, assignee |
| Notification UI | Create ticket (admin); link to existing ticket when present |
| Admin settings | Toggles per notification type for auto-create |

## Testing (v1)

- CRUD + comment + status transitions  
- Dedupe on `source_notification_id`  
- Auto-create on / off per type; notify path still succeeds if ticket insert fails  
- Page / actions gated `user:admin`

## Out of scope

SLA, AI triage, email-in, end-user portal, Spec 34 ticket draft, per-alert-rule
overrides, export.
