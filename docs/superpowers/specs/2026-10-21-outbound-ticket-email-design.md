# Spec 33 — Outbound ticket email

**Date**: 2026-10-21  
**Status**: Accepted (implemented on branch)  
**Parent**: [Spec 33 ticketing](../../specs/33-ticketing/index.md)  
**Branch**: `feat/spec-33-outbound-ticket-email`

## Goal

Email the ticket **assignee** when an admin assigns the ticket, adds a **user**
comment, or changes **status**. Reuse aw-auth notify + Resend. Outbound only —
no email-in. Create never fails because of email.

## Locked decisions

| Topic | Choice |
|---|---|
| Recipients (v1) | Assignee only |
| Future | Seam for admin toggle: requester ∪ assignee (same endpoint; expand recipients in web) |
| Events | `assigned`, `comment`, `status` — not ticket-created |
| Self | Skip when actor email equals assignee (case-insensitive) |
| Comments | `kind === "user"` only — no system comments |
| Architecture | Dedicated `POST /v1/notify/ticket` + web orchestration |
| Failure | Best-effort; log and swallow; ticket write already committed |
| Threads / email-in | Out of scope |

## Behavior

1. Admin updates a ticket (assignee and/or status) or adds a user comment.
2. After a successful DB write, web loads ticket fields needed for the email.
3. For each fired event:
   - **assigned** — `assigneeEmail` changed to a non-null value.
   - **status** — `status` changed.
   - **comment** — user comment inserted.
4. Recipients = `ticketNotifyRecipients(ticket, actor)`:
   - v1: `[assignee]` if set and ≠ actor; else `[]` → no send.
5. If recipients non-empty, web calls aw-auth `POST /v1/notify/ticket` with
   service credentials (`notify:send`).
6. aw-auth renders HTML (+ plain text) and sends via Resend to the explicit list.
7. One update that changes both assignee and status may send **two** emails
   (separate events / templates).

## API

### `POST /v1/notify/ticket` (aw-auth)

Auth: service account, scope `notify:send` (same as other notify routes).

Body (sketch):

```ts
{
  event: "assigned" | "comment" | "status";
  ticket: {
    id: string;
    number: number;
    subject: string;
    status: string;
    priority?: string;
    assigneeEmail?: string | null;
  };
  recipients: string[];           // required, non-empty
  detail: string;                 // comment body snippet, or "open → resolved", etc.
  actorEmail?: string;            // optional, for template copy
  ticketUrl?: string;             // optional absolute link from web
}
```

Response: `{ sent: boolean }` (same spirit as other notify endpoints).

### Web

- `sendTicketEmail(payload)` in `web/src/lib/notify.ts` — mirrors other helpers.
- `ticketNotifyRecipients(ticket, actorEmail, opts?)` — v1 assignee-only;
  later opts/flag adds requester.
- Hooks after success in ticket update / add-comment paths (data layer or
  actions — prefer next to the write so auto paths can share if needed).

## Email content

- Subject: e.g. `[H2Tecs] Ticket #42 — assigned` / `new comment` / `status updated`
- Body: ticket number, subject, event detail, actor if useful, optional `ticketUrl`
- No secrets; truncate long comment bodies (e.g. 2k chars)

`ticketUrl`: web builds from `WEB_PUBLIC_URL` (or equivalent) + `/tickets/{id}`
when configured; omit link if unset.

## Future toggle (not this slice)

Admin setting (name TBD, e.g. `ticket_email_include_requester`) expands
recipients to unique(assignee ∪ requester), still skip-self against actor.
No aw-auth change required if recipients stay explicit.

## Acceptance criteria

- **AC-E1**: Changing assignee to a non-null address emails that assignee (unless self).
- **AC-E2**: User comment emails current assignee (unless self / no assignee).
- **AC-E3**: Status change emails current assignee (unless self / no assignee).
- **AC-E4**: System comments and ticket create do not send.
- **AC-E5**: Empty recipients → no aw-auth call.
- **AC-E6**: Notify failure does not fail the ticket mutation.
- **AC-E7**: aw-auth only sends to the posted `recipients[]` (not admin broadcast).

## Out of scope

- Email-in / reply parsing / `In-Reply-To` threads
- Mail on ticket create
- Admin broadcast CC
- Portal / end-user UI
- Implementing the requester toggle (design seam only)
- Preferencing / digest / rate limits

## Self-review

- Assignee-only vs later requester toggle is explicit and web-owned.
- Skip-self and user-comment filter prevent noise.
- Two emails on dual field change is intentional simplicity.
- Completes Spec 33 Later “outbound” before email-in.
