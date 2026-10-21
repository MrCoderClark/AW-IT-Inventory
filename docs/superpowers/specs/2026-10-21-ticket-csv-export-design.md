# Spec 33 v2 — Ticket list CSV export

**Date**: 2026-10-21  
**Status**: Accepted (design)  
**Parent**: [Spec 33 ticketing](../../specs/33-ticketing/index.md)  
**Branch**: `feat/spec-33-ticket-csv-export`  
**UI reference**: Export control on [`docs/Design/ticketing-mock.png`](../../Design/ticketing-mock.png)

## Goal

Add a real **Export** control on `/tickets` that downloads the current filtered
ticket set as CSV, matching the asset-table export pattern. No SLA columns in
this slice (SLA is a follow-on v2 PR).

## Locked decisions

| Topic | Choice |
|---|---|
| Approach | Client-side CSV from already-loaded list rows |
| Row set | Current **filtered** tickets (search + status/priority/category/assignee), not pagination page only |
| Format | RFC 4180 CSV, UTF-8 BOM, CRLF — same as `assetsToCsv` / asset Export |
| Filename | `opus-tickets-YYYY-MM-DD.csv` (UTC date from `toISOString().slice(0, 10)`) |
| RBAC | Existing `/tickets` `user:admin` gate; no new permission |
| Description body | **Omitted** from CSV in this pass |
| Multi-format (xlsx/PDF) / server route | Out of scope |

## Columns (fixed order)

| Header | Source |
|---|---|
| Ticket ID | `ticketNumberLabel(number)` → `TKT-####` |
| Subject | `subject` |
| Asset | `assetTag` or empty |
| Location | `locationLabel` or empty |
| Category | `categoryLabel(category)` |
| Priority | `TICKET_PRIORITY_LABEL[priority]` |
| Status | `TICKET_STATUS_LABEL[status]` |
| Assignee | `assigneeEmail` or empty |
| Requester | `requesterEmail` or `createdBy` (same display rule as UI `requesterLabel`) |
| Created | ISO date-time string already on the list item (export as stored / display-stable string) |

## UI

- Outline **Export** button with Download icon, placed beside **New Ticket** in the
  list page header (mirror asset tables).
- Click builds CSV from `filtered` and triggers a browser download.
- When `filtered.length === 0`: disable the button **or** no-op with a short toast
  (“Nothing to export”); prefer disable for clarity.
- Toast on success optional (assets use “Export ready”); match that lightly if easy.

## Implementation sketch

1. **`web/src/lib/ticket-csv.ts`** — pure `ticketsToCsv(rows: TicketListItem[]): string`
   (+ shared `csvField` quoting, or thin private helper; do not import asset-column
   machinery). Unit tests for escaping, labels, empty fields, and row order.
2. **`web/src/components/tickets-view.tsx`** — wire Export button to `filtered`.
3. **Docs** — note export under Spec 33 v2; update `PROGRESS.md` when shipping.

## Acceptance criteria

- **AC-E1**: Admin on `/tickets` can export CSV of the filtered list.
- **AC-E2**: File columns and labels match the table above; status/priority use
  human labels including `waiting_on_user` → “Waiting on user”.
- **AC-E3**: Pagination does not limit the export (page size 10 still UI-only).
- **AC-E4**: Empty filter set does not download a header-only or garbage file
  (button disabled or equivalent).
- **AC-E5**: Non-admins still cannot reach `/tickets` (unchanged).

## Out of scope

- SLA / breach columns or KPI
- Per-alert-rule auto-create override
- Exporting comments, description, or attachment metadata
- Server-side export API
- xlsx / PDF

## Follow-on (separate PRs)

1. Simple SLA (fixed hours by priority; pause on `waiting_on_user`; breach KPI + list column)
2. Per-alert-rule ticket auto-create override (Spec 30)

## Self-review

- No placeholders or TBD column names.
- Does not contradict parked SLA: export has no SLA field.
- Scope is one PR; follow-ons listed separately.
