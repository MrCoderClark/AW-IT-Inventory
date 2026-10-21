# Spec 33 v2 — Per-alert-rule ticket auto-create override

**Date**: 2026-10-21  
**Status**: Accepted (design)  
**Parent**: [Spec 33 ticketing](../../specs/33-ticketing/index.md) · [Spec 30 alert rules](../../specs/30-alert-rules/index.md)  
**Branch**: `feat/spec-33-alert-rule-ticket-override`  
**Prior v2**: waiting status · [CSV export](./2026-10-21-ticket-csv-export-design.md) · [simple SLA](./2026-10-21-ticket-simple-sla-design.md)

## Goal

Let admins override the **global** notification-type ticket auto-create matrix
**per Spec 30 alert rule**, using a tri-state: Inherit · Force on · Force off.
Metric fire/recover notifications carry the rule id so auto-create can resolve
the override.

## Locked decisions

| Topic | Choice |
|---|---|
| Override shape | Tri-state on each rule: `inherit` \| `on` \| `off` |
| Storage | Column `alert_rules.ticket_auto_create` (text), default `inherit` |
| Rule linkage | `createNotification({ meta: { alertRuleId } })` on fire/recover |
| Resolution | `on` → always create; `off` → never; `inherit` / missing → global type toggle |
| Non-metric notifications | Unchanged (no `alertRuleId` → global only) |
| Recover events | Same override as fire (uses type `metric-recovered` + same rule id) |
| Best-effort | Auto-create failure never fails alert / notification insert |
| RBAC | Still `user:admin` |

## Resolution algorithm

```
maybeAutoCreateTicketFromNotification(row):
  mode = inherit
  ruleId = row.meta?.alertRuleId  // if available on the notification row
  if ruleId:
    mode = alert_rules.ticket_auto_create for ruleId  (missing rule → inherit)
  if mode === "on":
    createTicketFromNotification(...)
    return
  if mode === "off":
    return
  // inherit
  if ticket_auto_create_types[row.type].enabled:
    createTicketFromNotification(...)
```

Implementation note: today `maybeAutoCreate` only receives a slim row. Extend it
to accept `meta` (or load notification meta by id) so `alertRuleId` is visible.

## Schema

```ts
// alert_rules
ticketAutoCreate: text("ticket_auto_create")
  .$type<"inherit" | "on" | "off">()
  .notNull()
  .default("inherit"),
```

Existing rows pick up `inherit` via default / push. **Requires `npm run db:push`.**

## Fire path (Spec 30)

In `evaluateAlertRules` (or equivalent) when calling `createNotification` for
`metric-threshold` / `metric-recovered`, set:

```ts
meta: { alertRuleId: rule.id }
```

Do not change email or episode semantics.

## UI

- **Alert rules table / create-edit dialog** (`/admin/alert-rules`):
  - Field **Ticket auto-create**: Select — Inherit (default) · On · Off.
  - Short helper text: *Inherit follows Admin → Ticket auto-create for the
    metric notification types.*
- List column optional (narrow): show Inherit / On / Off badge; or only in dialog
  for v1 of this slice — prefer **dialog + table column** if space allows.
- Server actions for create/update include `ticketAutoCreate`; Zod validates enum.

## Acceptance criteria

- **AC-O1**: New column on `alert_rules` with default `inherit`.
- **AC-O2**: Metric fire/recover notifications store `meta.alertRuleId`.
- **AC-O3**: Override `on` creates a ticket even when the global type toggle is off.
- **AC-O4**: Override `off` skips ticket create even when the global type toggle is on.
- **AC-O5**: Override `inherit` matches today’s global-type behavior.
- **AC-O6**: Notifications without `alertRuleId` still use global types only.
- **AC-O7**: Admin can set the mode from the alert-rules UI; non-admins unchanged.
- **AC-O8**: Auto-create errors remain best-effort (logged, never throw into ingest).

## Out of scope

- Reworking the Admin “Ticket auto-create” type matrix itself
- Per-rule overrides for non-metric notification sources
- Changing which notification types alert rules emit
- Escalation / SLA policy per rule

## Self-review

- No placeholders for mode values or meta key name (`alertRuleId`).
- Recover uses the same override (via same rule id + `metric-recovered` global).
- Explicit `db:push` called out.
- Completes Spec 33 v2 “still open” list item.
