# Spec 33 UI polish — Helpdesk list + full ticket page

**Date**: 2026-10-20  
**Status**: Accepted (implemented on feat/spec-33-ticketing-helpdesk-ui)  
**Parent**: [Spec 33 ticketing](../../specs/33-ticketing/index.md) · [design v1](../../specs/33-ticketing/design-v1.md)  
**UI references**:
- America Works–style helpdesk mock (list + detail) — user-provided
- Original H2Tecs mock: [`docs/Design/ticketing-mock.png`](../../Design/ticketing-mock.png) (SLA/AI still parked)

## Goal

Make Ticketing feel like a service desk: a **KPI + table list** and a **full ticket detail page** (conversation-first), matching the two-section helpdesk mock. Keep H2Tecs shell, brand, and existing ticket APIs. No SLA, AI triage, tags, or related-tickets yet.

## Locked decisions

| Topic | Choice |
|---|---|
| Navigation shape | List at `/tickets` → full page at `/tickets/[id]` (no list side pane) |
| Visual target | America Works helpdesk mock (KPIs, table columns, conversation detail) |
| Branding | H2Tecs sidebar/header; do not adopt America Works logo/nav |
| Waiting KPI | Count of `waiting_on_user` (mock “On Hold” slot) |
| Requester | `createdBy` |
| Location | From linked asset’s office/location when present; else — |
| Conversation | User comments as thread messages; system comments on Activity |
| Schema / statuses / priorities | Unchanged (`open` \| `in_progress` \| `resolved` \| `closed`; `low` \| `medium` \| `high`) |
| RBAC | Still `user:admin` |
| Export / Critical / Tags / Related tickets / attachments | Parked |

## Information architecture

```
/tickets                 List dashboard (KPIs, filters, table, pagination)
/tickets/[id]            Full ticket workspace
New Ticket dialog        From list; on success navigate to /tickets/[id]
Notification create      Navigate to /tickets/[id] (not ?id= on list)
Deep links               /tickets/[id] only; drop list ?id= selection
```

Remove the right detail pane from the list view. Retire or gut `TicketDetailPane` usage on `/tickets` (logic moves into the detail page components).

## List page (`/tickets`)

### Layout (top → bottom)

1. **Page header** — Title “Tickets”, short subtitle (no AI claim). Primary button **Create Ticket**.
2. **KPI strip** — Four cards:
   - Open (`status === open`)
   - In Progress (`in_progress`)
   - Waiting (`waiting_on_user`) — mock “On Hold” slot
   - Resolved (`resolved`)
   Counts from the loaded ticket set. **No % / vs-prior deltas** in this pass (avoid fake or half-baked trend lines).
3. **Filter bar** — Search; Status; Priority; Category; Assignee (Assignee instead of mock’s Location filter).
4. **Table** — Columns: ID · Title · Requester · Category · Priority · Status · Created · Updated · Location. Colored pills for priority/status. Row click → `/tickets/[id]`.
5. **Pagination** — Client-side, **page size 10**; footer styled like the mock.

### Data

Reuse `listTickets()`. Extend list item (or join in the query) with **`locationLabel: string | null`** from the linked asset’s location path when available. `createdAt` / `updatedAt` / `createdBy` already exist.

## Detail page (`/tickets/[id]`)

### Layout

1. **Chrome** — “← Back to Tickets”; priority badge + `#TKT-{n}`; subject as H1; description under title; Created / Updated timestamps.
2. **Action bar** — Status select; **Add note** (focuses composer); **Assign** (inline assignee email); **Update** (saves dirty status/priority/assignee via existing `updateTicketAction`). No “More” menu in this pass.
3. **Main column — tabs**
   - **Conversation** (default): threaded user comments (initials avatar, author, relative/absolute time); composer + Send → `addTicketCommentAction`.
   - **Activity**: system comments (and any future audit lines).
   - **Details**: category, source notification link if `sourceNotificationId`, created by.
   - **Assets**: card for linked asset (tag, name, link to asset page) or empty state.
   - **Related tickets**: omit tab (parked).
4. **Right sidebar**
   - **Ticket details** card: ID, status, priority, category, requester, assignee, location, created, updated.
   - **Related asset** card (same as Assets tab content, compact).
   - No Tags card yet.

### Data

Reuse `getTicket` / `getTicketAction`. Page is a server component that loads the ticket (404 / not-found if missing) and passes into a client workspace for actions. Permission gate same as list (`user:admin`).

## Components (proposed)

| Piece | Notes |
|---|---|
| `TicketsView` | List-only: KPIs, filters, table, pagination, create dialog |
| `TicketKpiStrip` | Four summary cards |
| `tickets/[id]/page.tsx` | Auth + load ticket |
| `TicketWorkspace` | Detail shell: header, actions, tabs, sidebar |
| `TicketConversation` | Thread + composer |
| `ticket-ui.ts` | Stronger status/priority badge colors to match mock |

Delete or stop using side-pane selection on the list. Keep `NewTicketDialog`.

## Error handling

- List: empty state when no tickets / no filter matches (unchanged messaging tone).
- Detail: missing id → notFound(); action failures → toast (existing pattern).
- Assign invalid email → server validation error toast.

## Testing

- Update any tests that assume list `?id=` or `TicketDetailPane` on `/tickets`.
- Add/adjust component or route smoke coverage for `/tickets/[id]` render + conversation vs activity split (user vs system comments).
- KPI counts: unit helper over ticket arrays preferred over brittle UI snapshots.

## Out of scope

- SLA column / breach KPI / escalation.
- AI triage / auto-triage toggle / confidence UI.
- Export, Critical priority, On Hold as a real status, tags, related tickets, attachments, email thread.
- Changing America Works–only branding (dark blue dedicated service-desk nav).

## Acceptance criteria

- **AC-UI-1**: `/tickets` has no detail side pane; shows KPI strip + table with the columns above; row navigates to `/tickets/[id]`.
- **AC-UI-2**: `/tickets/[id]` matches the helpdesk detail structure (back link, actions, Conversation tab, right meta sidebar).
- **AC-UI-3**: Create ticket / notification create / nav deep links land on `/tickets/[id]`.
- **AC-UI-4**: Existing ticket CRUD + comments still work; still gated `user:admin`.
- **AC-UI-5**: No SLA/AI/fake KPI percentages; Waiting (`waiting_on_user`) fills the On Hold slot.

## Migration / follow-ups

- Update Spec 33 index AC-6 from “list + right detail pane” to “list dashboard + full detail page”.
- Optional later: Location filter; tags; related tickets.
