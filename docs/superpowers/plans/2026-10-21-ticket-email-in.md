# Ticket email-in (reply-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resend inbound webhook on web appends a user comment when mail matches ticket `[#N]` (or stored Message-ID) and From is assignee or requester; unmatched/unauthorized → 200 + log; no create-from-mail; no attachments.

**Architecture:** Schema `ticket_email_messages`. Outbound subjects gain `[#N]` and record Message-IDs. Web `POST /api/ingest/email` verifies Resend/Svix signature, fetches body via Receiving API (`RESEND_API_KEY` on web), resolves ticket, authorizes From, idempotent insert + comment.

**Tech Stack:** Next.js route handler, Drizzle, Vitest, Resend Receiving + webhooks (`resend` npm or `svix`), aw-auth `_deliver` / `send_ticket_event` tweak for subject + returned id.

**Spec:** [`docs/superpowers/specs/2026-10-21-ticket-email-in-design.md`](../specs/2026-10-21-ticket-email-in-design.md)

## Global Constraints

- Reply-only — never create tickets from mail
- From must be assignee or requester (case-insensitive)
- Invalid signature → 4xx; unmatched/unauthorized/duplicate → **200** + log (no comment)
- Attachments ignored (do not download/store)
- Subject token `[#N]` mandatory on outbound ticket mail
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell; quote `(app)` paths; `npm run db:push` after schema (user runs)
- Env: `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY` on **web** for receiving fetch (send keys stay on aw-auth)

---

## File structure

| File | Role |
|---|---|
| `web/src/db/schema.ts` | `ticketEmailMessages` table |
| `web/src/db/ticket-email.ts` (+ test) | CRUD Message-IDs; `getTicketByNumber`; process inbound |
| `web/src/lib/email-inbound.ts` (+ test) | Parse subject, From, strip quotes; normalize payload |
| `web/src/lib/resend-inbound.ts` (+ test) | Verify webhook; fetch receiving email |
| `web/src/app/api/ingest/email/route.ts` (+ test) | HTTP handler |
| `aw-auth/accounts/notifications.py` | Subject `[#N]`; return Resend id from ticket send |
| `aw-auth/accounts/views.py` | `{ ok, sent, messageId? }` on ticket notify |
| `web/src/lib/notify.ts` + `ticket-notify.ts` | Record outbound Message-ID after send |
| Spec 33 / PROGRESS / design / `.env.example` | Docs |

---

### Task 1: Schema + Message-ID helpers

**Files:**
- Modify: `web/src/db/schema.ts` (after `ticketComments`)
- Create: `web/src/db/ticket-email.ts`
- Create: `web/src/db/ticket-email.test.ts`

**Interfaces:**
- Produces: table `ticket_email_messages`; `recordTicketEmailMessage(...)`; `findTicketIdByMessageId(messageId)`; `inboundMessageExists(messageId)`; `getTicketByNumber(number)`

- [ ] **Step 1: Add schema**

```ts
export const ticketEmailMessages = pgTable(
  "ticket_email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    direction: text("direction")
      .$type<"outbound" | "inbound">()
      .notNull(),
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    fromEmail: text("from_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("ticket_email_messages_message_id_uidx").on(t.messageId),
    index("ticket_email_messages_ticket_id_idx").on(t.ticketId),
  ],
);
```

- [ ] **Step 2: Failing tests for helpers** (mock `db` like other db tests)

```ts
it("records and finds by messageId", async () => { /* ... */ });
it("inboundMessageExists true after insert", async () => { /* ... */ });
```

Implement `getTicketByNumber` selecting id, number, assigneeEmail, requesterEmail, subject, status.

- [ ] **Step 3: Implement helpers → PASS**

- [ ] **Step 4: Commit** (note in commit body: run `npm run db:push`)

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/schema.ts web/src/db/ticket-email.ts web/src/db/ticket-email.test.ts
git commit -m @"
feat(spec 33): ticket_email_messages schema and helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: Parse helpers (pure)

**Files:**
- Create: `web/src/lib/email-inbound.ts`
- Create: `web/src/lib/email-inbound.test.ts`

**Interfaces:**
- `parseTicketNumberFromSubject(subject: string): number | null` — match `/\[#(\d+)\]/`
- `normalizeEmailAddress(from: string): string` — strip `Name <email>` → lowercased email
- `stripQuotedReply(text: string): string` — cut on `/^On .+ wrote:$/m` or lines starting with `>`; trim; max 8000 chars
- `extractInReplyTo(headers: Record<string, string> | undefined): string | null` — case-insensitive `in-reply-to`

- [ ] **Step 1: Failing tests** covering `[#42]`, missing token, display-name From, quoted strip, empty body.

- [ ] **Step 2: Implement → PASS → Commit**

```powershell
git add web/src/lib/email-inbound.ts web/src/lib/email-inbound.test.ts
git commit -m @"
feat(spec 33): inbound email parse helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Outbound `[#N]` + Message-ID return

**Files:**
- Modify: `aw-auth/accounts/notifications.py` (`send_ticket_event`, optionally `_deliver` ticket-only path)
- Modify: `aw-auth/accounts/views.py` (`TicketNotifyView` response)
- Modify: `aw-auth/accounts/tests.py`
- Modify: `web/src/lib/notify.ts` (`sendTicketEmail` → `{ sent: boolean; messageId?: string }`)
- Modify: `web/src/db/ticket-notify.ts` (after successful send, `recordTicketEmailMessage` outbound)
- Modify: related tests

**Interfaces:**
- Subject becomes: `f"[H2Tecs] [#{number}] — {verb}"`
- `_deliver` for ticket sends: read Resend JSON body for `"id"`; return `(True, id)` or change `send_ticket_event` → `tuple[bool, str | None]`
- View: `{ "ok": True, "sent": sent, "messageId": message_id }` (omit/null if missing)
- Web: if `sent && messageId`, record outbound with `ticket.id`

**Note:** Resend’s send `id` is not always an RFC Message-ID. Still store it; primary inbound match is `[#N]`. Prefer also setting send headers:

```python
"headers": {"X-Ticket-Number": str(number)}
```

If Resend allows custom `Message-ID`, set `<ticket-{ticket_id}-{uuid}@h2tecs.local>` and store that — only if their API accepts it; otherwise store Resend `id`.

- [ ] **Step 1: Failing aw-auth test** — subject contains `[#42]`; response includes messageId when mocked Resend body `{"id":"re_abc"}`.

- [ ] **Step 2: Implement deliver return + subject → PASS**

- [ ] **Step 3: Web records outbound Message-ID → PASS**

- [ ] **Step 4: Commit**

```powershell
git add aw-auth/accounts/notifications.py aw-auth/accounts/views.py aw-auth/accounts/tests.py web/src/lib/notify.ts web/src/lib/notify.test.ts web/src/db/ticket-notify.ts web/src/db/ticket-notify.test.ts
git commit -m @"
feat(spec 33): outbound ticket subject [#N] and message id

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: `processInboundEmail` core

**Files:**
- Create/extend: `web/src/db/ticket-email.ts` with `processInboundEmail(input) → { status: "commented" | "ignored" | "duplicate"; reason?: string }`
- Modify: `web/src/db/ticket-email.test.ts`
- Create: `web/src/lib/resend-inbound.ts` — `verifyResendWebhook` + `fetchReceivedEmail(emailId)`

**Input shape (normalized):**

```ts
type InboundEmail = {
  emailId: string;
  messageId: string;
  from: string;
  subject: string;
  text: string | null;
  html: string | null;
  headers?: Record<string, string>;
};
```

**Algorithm:**

```ts
export async function processInboundEmail(mail: InboundEmail): Promise<...> {
  if (!mail.messageId) return { status: "ignored", reason: "no_message_id" };
  if (await inboundMessageExists(mail.messageId))
    return { status: "duplicate" };

  const from = normalizeEmailAddress(mail.from);
  let ticketId =
    (await findTicketIdByMessageId(extractInReplyTo(mail.headers) ?? "")) ??
    null;
  // also try matching References tokens if present — optional YAGNI: In-Reply-To only

  if (!ticketId) {
    const n = parseTicketNumberFromSubject(mail.subject);
    if (n != null) {
      const t = await getTicketByNumber(n);
      ticketId = t?.id ?? null;
    }
  }
  if (!ticketId) return { status: "ignored", reason: "no_ticket" };

  const ticket = await getTicket(ticketId); // existing helper
  if (!ticket) return { status: "ignored", reason: "no_ticket" };

  const allowed = [ticket.assigneeEmail, ticket.requesterEmail]
    .filter(Boolean)
    .map((e) => e!.trim().toLowerCase());
  if (!allowed.includes(from))
    return { status: "ignored", reason: "unauthorized" };

  const raw = mail.text?.trim() || htmlToTextRough(mail.html) || "";
  const body = stripQuotedReply(raw);
  if (!body) return { status: "ignored", reason: "empty_body" };

  // Insert message row FIRST (unique) to win races; on conflict → duplicate
  try {
    await recordTicketEmailMessage({
      ticketId: ticket.id,
      direction: "inbound",
      messageId: mail.messageId,
      inReplyTo: extractInReplyTo(mail.headers),
      fromEmail: from,
    });
  } catch {
    return { status: "duplicate" };
  }

  await addTicketComment(ticket.id, {
    authorEmail: from,
    body,
    kind: "user",
  });
  // Optional: trigger outbound notify via maybeNotifyTicketComment
  await maybeNotifyTicketComment({
    ticket: { ... },
    actorEmail: from,
    body,
    kind: "user",
  });

  return { status: "commented" };
}
```

`htmlToTextRough`: strip tags with a minimal replace if text null — keep tiny.

**Resend client:**

```ts
// Prefer official `resend` package: npm install resend
// verify: resend.webhooks.verify({ payload, headers, secret })
// fetch: GET https://api.resend.com/emails/receiving/{email_id}
```

- [ ] **Step 1: Failing process tests** — happy path, unauthorized, no ticket, duplicate, empty body (mock db + addTicketComment).

- [ ] **Step 2: Implement → PASS**

- [ ] **Step 3: Commit**

```powershell
git add web/src/db/ticket-email.ts web/src/db/ticket-email.test.ts web/src/lib/resend-inbound.ts web/src/lib/resend-inbound.test.ts web/package.json web/package-lock.json
git commit -m @"
feat(spec 33): process inbound ticket email replies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 5: `POST /api/ingest/email` route

**Files:**
- Create: `web/src/app/api/ingest/email/route.ts`
- Create: `web/src/app/api/ingest/email/route.test.ts`
- Modify: `web/.env.example`

**Handler:**

```ts
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    verifyResendWebhook(raw, req.headers); // throws if bad
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const event = JSON.parse(raw) as { type?: string; data?: { email_id?: string; message_id?: string; from?: string; subject?: string } };
  if (event.type !== "email.received" || !event.data?.email_id) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const full = await fetchReceivedEmail(event.data.email_id);
  if (!full) {
    console.error("[ingest/email] fetch failed", event.data.email_id);
    return NextResponse.json({ ok: true, ignored: true }); // avoid endless retry if permanent; or 500 for retry — prefer 200 + log for missing content
  }

  // Ignore attachment content — do not call attachments API
  const result = await processInboundEmail({
    emailId: event.data.email_id,
    messageId: full.message_id || event.data.message_id || event.data.email_id,
    from: full.from || event.data.from || "",
    subject: full.subject || event.data.subject || "",
    text: full.text,
    html: full.html,
    headers: full.headers,
  });

  return NextResponse.json({ ok: true, ...result });
}
```

`.env.example`:

```
# Resend inbound (email-in). Webhook signing secret from Resend dashboard.
# RESEND_WEBHOOK_SECRET=whsec_...
# API key used only to fetch received email body (send stays on aw-auth).
# RESEND_API_KEY=re_...
```

- [ ] **Step 1: Route tests** — bad signature 401; happy path mocked verify+fetch+process; unauthorized still 200.

- [ ] **Step 2: Implement → PASS → Commit**

```powershell
git add "web/src/app/api/ingest/email" web/.env.example
git commit -m @"
feat(spec 33): Resend inbound webhook for ticket replies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/specs/33-ticketing/index.md` — mark email-in reply-only shipped on branch
- Modify: `PROGRESS.md`
- Modify: design Status → implemented on branch
- Ops note: Resend MX + webhook URL `https://<web>/api/ingest/email` + `db:push`

- [ ] **Step 1: Update docs → Commit**

```powershell
git add docs/specs/33-ticketing/index.md PROGRESS.md docs/superpowers/specs/2026-10-21-ticket-email-in-design.md
git commit -m @"
docs(spec 33): mark ticket email-in reply-only on branch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

## Spec coverage

| AC | Task |
|---|---|
| AC-I1 commented | Task 4–5 |
| AC-I2 unauthorized | Task 4–5 |
| AC-I3 no ticket | Task 4–5 |
| AC-I4 duplicate | Task 4 |
| AC-I5 signature | Task 5 |
| AC-I6 no attachments | Task 5 (never fetch attachments) |
| AC-I7 outbound [#N] + message id | Task 3 |

## Placeholder scan

Resend send Message-ID vs API `id`: implementers must store whatever id Resend returns and rely on `[#N]` as primary match. Document choice in the Task 3 commit message.

## Type consistency

`processInboundEmail` / `ticketEmailMessages` / `[#N]` / `RESEND_WEBHOOK_SECRET` / `RESEND_API_KEY` on web.
