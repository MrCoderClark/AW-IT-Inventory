# Spec 34 — Ticket draft assist (from notification)

**Date**: 2026-10-21  
**Status**: Accepted (implemented on `feat/spec-34-ticket-draft-assist`)  
**Parent**: [Spec 34 AI-assisted ops](../../specs/34-ai-assisted-ops/index.md) · [Spec 33 ticketing](../../specs/33-ticketing/index.md)  
**Branch**: `feat/spec-34-ticket-draft-assist`

## Goal

Enhance the existing notification **Create ticket** button so that, when AI is
configured, the ticket’s subject/description (and optionally category/priority)
are drafted from the **alert/notification** before insert. Auto-create stays
non-AI. Create never fails because of AI.

## Locked decisions

| Topic | Choice |
|---|---|
| Entry point | Notification feed **Create ticket** only (manual) |
| UX | One-click create (enhance in place); no separate draft dialog |
| Auto-create (`system:auto`) | **No AI** — raw notification title/body |
| AI off / error / timeout | Fall back to today’s fields |
| Execution | **Sync** provider `complete` inside the create path (short timeout); not Assist job queue |
| RBAC | `user:admin` (same as Create ticket today) |
| Computer Assist panel | Out of scope this slice |

## Behavior

1. Admin clicks **Create ticket** on a notification (no existing ticket).
2. Server loads notification (+ linked asset summary if `assetId` present).
3. If AI provider is configured (`AI_PROVIDER` ≠ noop):
   - Build a redacted **notification context pack**.
   - Call Assist action `draft_ticket` → structured `ticketDraft`.
   - Validate optional category against `TICKET_CATEGORIES`; optional priority
     against `low|medium|high`; discard invalid optionals.
   - Create ticket with drafted subject/description (+ valid optionals).
4. Else / on AI failure: create with `subject = title`, `description = body`,
   `category = categoryFromNotificationType(type)` as today.
5. Dedupe on `sourceNotificationId` unchanged. Navigate/toast unchanged.

## Context pack (server-only)

Include only:

- Notification: `type`, `severity`, `title`, `body` (truncated if huge)
- Asset (if linked): tag, name, type, location label — **no** credentials, tokens,
  or full event dumps

## API / types

Extend Spec 34 assist types:

```ts
AssistAction += "draft_ticket"

AssistResult += {
  ticketDraft?: {
    subject: string;
    description: string;
    category?: string;
    priority?: "low" | "medium" | "high";
  };
}
```

Implementation may call the provider **directly** from
`createTicketFromNotification` / a dedicated helper (e.g.
`draftTicketFieldsFromNotification`) rather than going through the Assist job
table — jobs remain for computer Assist UX.

Optional: allow `POST /api/ai/assist` with `action: "draft_ticket"` +
`notificationId` for testing; **not required** for the Create button path.

## Code touchpoints (sketch)

- `web/src/lib/ai/types.ts` + parse/prompts for `draft_ticket`
- Context pack builder for notifications (+ asset join)
- `createTicketFromNotification` — optional AI enhance for human `createdBy`
  only (detect `createdBy !== "system:auto"` **or** pass `opts: { useAi?: boolean }`
  from the server action; auto-create passes `useAi: false`)
- `createTicketFromNotificationAction` — enable AI for admin clicks
- Tests: fallback when AI off; AI draft applied when mocked; auto-create never
  calls AI; invalid category discarded
- Docs: Spec 34 phases (promote ticket-draft from Later); Spec 33 note; PROGRESS

## Acceptance criteria

- **AC-T1**: With AI configured, manual Create ticket uses drafted subject/description when the provider succeeds.
- **AC-T2**: With AI off or on provider error, create succeeds with raw notification fields.
- **AC-T3**: Auto-create never invokes the AI provider.
- **AC-T4**: Invalid AI category/priority are ignored; ticket still creates.
- **AC-T5**: Dedupe / `sourceNotificationId` behavior unchanged.
- **AC-T6**: No secrets in the context pack; Assist UI hidden when AI off (unchanged).

## Out of scope

- Prefill New Ticket dialog without creating
- Computer Assist “Draft ticket” action
- AI on auto-create
- Async Assist jobs / streaming for this path
- Email-in / outbound ticket email
- Changing auto-create type matrix or alert-rule overrides

## Self-review

- Auto-create vs manual split is explicit (no accidental AI on ingest).
- Fallback guarantees create reliability.
- Category/priority validation prevents free-text pollution of fixed enums.
- Completes Spec 34 “Later — ticket draft assist” for the notification entry point.
