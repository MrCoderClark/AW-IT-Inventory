# Spec 33 — Ticket email-in (reply-only)

**Date**: 2026-10-21  
**Status**: Accepted (design)  
**Parent**: [Spec 33 ticketing](../../specs/33-ticketing/index.md)  
**Branch**: `feat/spec-33-ticket-email-in`  
**Depends on**: Outbound ticket email (#116)

## Goal

Accept **inbound email replies** via Resend webhook and append them as **user
comments** on existing tickets when the sender is the assignee or requester.
Unmatched or unauthorized mail is logged and ignored. No create-from-mail, no
attachment storage in this slice.

## Locked decisions

| Topic | Choice |
|---|---|
| Scope | Reply-only (no new tickets from mail) |
| Transport | Resend inbound webhook |
| Match | Subject `[#N]` primary; `In-Reply-To` / `References` via stored Message-IDs |
| AuthZ | From must be assignee **or** requester (case-insensitive) |
| Attachments | Ignore / do not store |
| Architecture | Web owns webhook + ticket write |
| Failure / spam | Invalid signature rejected; unmatched/unauthorized → 200 + log (no comment) |

## Behavior

1. Outbound ticket emails include a stable subject token `[#N]` and record an
   `outbound` Message-ID when available.
2. Resend delivers a signed inbound event to web `POST /api/ingest/email`.
3. Web verifies the Resend/Svix signature.
4. Parse From, subject, plain-text body (prefer text/plain; strip HTML if needed),
   Message-ID, In-Reply-To / References.
5. Resolve ticket:
   - Look up Message-ID / In-Reply-To in `ticket_email_messages`; else
   - Parse `[#N]` (or equivalent `#N` token) from subject.
6. If no ticket → log, return 200, stop.
7. If From ∉ {assigneeEmail, requesterEmail} → log, return 200, stop.
8. Idempotency: if inbound Message-ID already stored → return 200, no second comment.
9. Best-effort strip quoted reply; truncate body; `addTicketComment` with
   `authorEmail = From`, `kind = "user"`.
10. Store `inbound` row in `ticket_email_messages`.
11. Existing outbound notify may email the other party (e.g. requester replies →
    assignee notified) via current skip-self rules.

## Data

```ts
// ticket_email_messages (web DB)
{
  id: uuid;
  ticketId: uuid; // FK tickets
  direction: "outbound" | "inbound";
  messageId: string; // unique
  inReplyTo: string | null;
  fromEmail: string | null;
  createdAt: timestamptz;
}
```

Outbound path (`send_ticket_event` / web after successful send): upsert/insert
outbound Message-ID linked to ticket.

## API

### `POST /api/ingest/email` (web)

- Auth: Resend webhook signature (`RESEND_WEBHOOK_SECRET`), **not** service JWT.
- Body: Resend inbound payload (normalized in code to From / subject / text /
  headers / message_id).
- Response: `200` on handled (including ignore paths); `4xx` on bad signature.

## Security

- Signature required.
- Closed authorize list (assignee + requester only).
- No open create-from-mail.
- Comments stored as text; UI continues to escape; do not treat HTML as trusted.
- Attachments discarded.

## Outbound subject tweak

Change ticket email subjects to include `[#N]`, e.g.

`[H2Tecs] [#42] — assigned`

Keep human-readable verb; token must be reliably parseable.

## Acceptance criteria

- **AC-I1**: Reply with `[#N]` from assignee or requester creates a user comment on ticket N.
- **AC-I2**: Wrong From does not create a comment (200 + log).
- **AC-I3**: Unknown / unparseable ticket does not create (200 + log).
- **AC-I4**: Duplicate inbound Message-ID is idempotent.
- **AC-I5**: Invalid webhook signature is rejected.
- **AC-I6**: Attachments do not create stored files or comment blobs.
- **AC-I7**: Outbound subjects contain `[#N]`; outbound Message-IDs recorded when available.

## Out of scope

- Create ticket from unmatched mail
- Attachment storage / inline image hosting
- IMAP / non-Resend transports
- End-user portal
- Full MIME forensic parsing / DKIM beyond Resend’s verified webhook
- Admin UI for mailbox settings (env-based config is enough)

## Follow-ups (later slices)

- Create-from-mail
- Attachments
- Broader allow-list / domain allow rules
- Requester+assignee outbound toggle (already seamed)

## Self-review

- Reply-only keeps security surface small while proving thread model with #116.
- Webhook on web matches ticket ownership; signature replaces service JWT.
- Message-ID table enables header matching without relying on subject alone.
- Idempotent inbound Message-ID avoids duplicate comments on Resend retries.
