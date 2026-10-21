# Outbound ticket email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email the ticket assignee on assign, user comment, and status change via aw-auth `POST /v1/notify/ticket` + Resend; best-effort, assignee-only, skip-self.

**Architecture:** aw-auth adds `send_ticket_event` + `TicketNotifyView` (explicit `recipients[]`, like report delivery). Web adds `ticketNotifyRecipients` + `sendTicketEmail`, then hooks after successful ticket update/comment in the data layer (or actions calling a small `maybeNotifyTicket*` helper). Later requester toggle only expands recipients in web.

**Tech Stack:** Django/DRF (aw-auth), Resend via existing `_deliver`, Next.js server actions + Vitest (web), existing `h2tecs-web` / `notify:send`.

**Spec:** [`docs/superpowers/specs/2026-10-21-outbound-ticket-email-design.md`](../specs/2026-10-21-outbound-ticket-email-design.md)

## Global Constraints

- Recipients v1: assignee only; skip when actor email equals assignee (case-insensitive)
- Events: `assigned` | `comment` | `status` only — no create-ticket mail
- User comments only (`kind === "user"`); system comments silent
- Best-effort: notify failure must not fail ticket mutations
- Explicit `recipients[]` — never admin broadcast for this endpoint
- Seam: `ticketNotifyRecipients` may later accept `includeRequester` without changing aw-auth
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Shell: PowerShell; quote `(app)` paths; aw-auth tests via `uv run pytest`

---

## File structure

| File | Role |
|---|---|
| `aw-auth/accounts/notifications.py` | `send_ticket_event(...)` |
| `aw-auth/accounts/views.py` | `TicketNotifyView` |
| `aw-auth/config/urls.py` | `v1/notify/ticket` |
| `aw-auth/accounts/tests.py` (or new test module) | Resend + validation tests |
| `web/src/lib/notify.ts` + `.test.ts` | `sendTicketEmail` |
| `web/src/db/ticket-notify.ts` + `.test.ts` | recipients + maybe-notify helpers |
| `web/src/db/tickets.ts` | Load-before-update; call maybe-notify after write |
| `web/src/db/tickets.test.ts` / action tests | Wire coverage |
| Spec 33 / PROGRESS / design Status | Docs |

---

### Task 1: aw-auth `send_ticket_event`

**Files:**
- Modify: `aw-auth/accounts/notifications.py`
- Modify: `aw-auth/accounts/tests.py` (append `TicketNotifyResendTest` near `ReportDeliveryResendTest`)

**Interfaces:**
- Produces: `send_ticket_event(event, ticket, recipients, detail, *, actor_email=None, ticket_url=None) -> bool`
  - Uses `_deliver(..., recipients=recipients, html=...)` — never `resolve_admin_emails` default

- [ ] **Step 1: Failing test**

Append to `aw-auth/accounts/tests.py`:

```python
class TicketNotifyResendTest(TestCase):
    """Outbound ticket email (Spec 33) — explicit recipients only."""

    def setUp(self):
        os.environ["RESEND_API_KEY"] = "re_test_key"
        os.environ["EMAIL_FROM"] = "H2Tecs <tickets@example.com>"

    def tearDown(self):
        os.environ.pop("RESEND_API_KEY", None)
        os.environ.pop("EMAIL_FROM", None)

    @patch.object(notifications, "resolve_admin_emails", return_value=["admin@x.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_sends_to_explicit_recipients(self, mock_urlopen, mock_admins):
        import json

        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        ok = notifications.send_ticket_event(
            "assigned",
            {
                "id": "t1",
                "number": 42,
                "subject": "Disk full",
                "status": "open",
                "assigneeEmail": "tech@co.com",
            },
            ["tech@co.com"],
            "Assigned to tech@co.com",
            actor_email="admin@co.com",
            ticket_url="https://inventory.example/tickets/t1",
        )

        self.assertTrue(ok)
        body = json.loads(mock_urlopen.call_args.args[0].data)
        self.assertEqual(body["to"], ["tech@co.com"])
        mock_admins.assert_not_called()
        self.assertIn("#42", body["subject"])
        self.assertIn("assigned", body["subject"].lower())
        self.assertIn("Disk full", body["text"])
        self.assertIn("https://inventory.example/tickets/t1", body["text"])
        self.assertIn("<", body["html"])  # has HTML

    @patch("accounts.notifications.urllib.request.urlopen")
    def test_returns_false_without_recipients(self, mock_urlopen):
        ok = notifications.send_ticket_event(
            "comment",
            {"id": "t1", "number": 1, "subject": "x", "status": "open"},
            [],
            "hi",
        )
        self.assertFalse(ok)
        mock_urlopen.assert_not_called()
```

- [ ] **Step 2: Run — FAIL**

```powershell
cd D:\Code\aw\aw-inventory\aw-auth
uv run pytest accounts/tests.py::TicketNotifyResendTest -q
```

Expected: `send_ticket_event` missing / FAIL.

- [ ] **Step 3: Implement**

In `notifications.py`:

```python
def send_ticket_event(
    event: str,
    ticket: dict,
    recipients: list[str],
    detail: str,
    *,
    actor_email: str | None = None,
    ticket_url: str | None = None,
) -> bool:
    """Email explicit recipients about a ticket event (Spec 33 outbound).

    ``event`` is assigned | comment | status. Never falls back to admin list.
    """
    if not recipients:
        logger.warning("ticket-notify (%s) not sent: no recipients.", event)
        return False

    number = ticket.get("number")
    subject_line = ticket.get("subject") or "(no subject)"
    verb = {
        "assigned": "assigned",
        "comment": "new comment",
        "status": "status updated",
    }.get(event, event)

    subject = f"[H2Tecs] Ticket #{number} — {verb}"
    lines = [
        f"Ticket #{number}: {subject_line}",
        f"Status: {ticket.get('status') or '—'}",
        f"Event: {verb}",
        f"Detail: {detail}",
    ]
    if actor_email:
        lines.append(f"By: {actor_email}")
    if ticket_url:
        lines.append(f"Open: {ticket_url}")
    body = "\n".join(lines)

    # Minimal HTML — escape user-controlled strings
    import html as html_mod

    esc = html_mod.escape
    html_parts = [
        f"<p><strong>Ticket #{esc(str(number))}</strong>: {esc(str(subject_line))}</p>",
        f"<p>Status: {esc(str(ticket.get('status') or '—'))}</p>",
        f"<p>Event: {esc(verb)}</p>",
        f"<p>Detail: {esc(detail)}</p>",
    ]
    if actor_email:
        html_parts.append(f"<p>By: {esc(actor_email)}</p>")
    if ticket_url:
        safe_url = esc(ticket_url)
        html_parts.append(f'<p><a href="{safe_url}">Open ticket</a></p>')
    html = "\n".join(html_parts)

    return _deliver(
        subject,
        body,
        label=f"ticket-notify ({event})",
        html=html,
        recipients=recipients,
    )
```

Put `import html` at module top if preferred over inline.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add aw-auth/accounts/notifications.py aw-auth/accounts/tests.py
git commit -m @"
feat(spec 33): aw-auth send_ticket_event via Resend

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 2: aw-auth `TicketNotifyView` + URL

**Files:**
- Modify: `aw-auth/accounts/views.py`
- Modify: `aw-auth/config/urls.py`
- Modify: `aw-auth/accounts/tests.py` (API test if service-token notify tests exist; else unit-test the view validation via APIClient with a service JWT — follow nearest notify view test; if none, add a focused validation test by calling the view with a mocked `send_ticket_event`)

**Interfaces:**
- Consumes: `send_ticket_event`
- Produces: `POST /v1/notify/ticket` → `{ ok: true, sent: bool }`
- Auth: `HasServiceScope`, `required_scope = "notify:send"`

- [ ] **Step 1: Failing route/view test**

Prefer an APIClient test with a service account token if the suite already has that helper. Minimal alternative — test validation by posting without auth expectations matching `ReportDeliveryView` patterns in the codebase. If no API helper, add:

```python
# In TicketNotifyResendTest or a new class — patch send_ticket_event and hit the URL
# with force_authenticate / service scope fixture used elsewhere for notify.
```

Inspect existing notify view tests; mirror one. If truly none, skip HTTP test and assert view class exists + url reverse in a tiny Django test:

```python
from django.urls import reverse

class TicketNotifyUrlTest(TestCase):
    def test_url_resolves(self):
        self.assertEqual(reverse("notify-ticket"), "/v1/notify/ticket")
```

Plus a unit test that instantiates validation by calling `TicketNotifyView().post` with a RequestFactory and mocked auth — only if you can do it cleanly in <20 lines. Prefer reverse + send_ticket_event already covered in Task 1; view body can be verified by a RequestFactory test:

```python
from rest_framework.test import APIRequestFactory, force_authenticate
# Follow whichever pattern PrinterAlertView / ReportDeliveryView tests use.
```

- [ ] **Step 2: Implement view + url**

`views.py` (mirror `ReportDeliveryView`):

```python
class TicketNotifyView(APIView):
    """Outbound ticket email (Spec 33). Explicit recipients[]; notify:send."""

    authentication_classes: list = []
    permission_classes = [HasServiceScope]
    required_scope = "notify:send"

    @extend_schema(request=None, responses={200: None})
    def post(self, request):
        event = request.data.get("event")
        ticket = request.data.get("ticket") or {}
        recipients = request.data.get("recipients")
        detail = request.data.get("detail")
        actor_email = request.data.get("actorEmail")
        ticket_url = request.data.get("ticketUrl")

        if event not in ("assigned", "comment", "status"):
            return Response(
                {"detail": "event must be assigned|comment|status"},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if not isinstance(ticket, dict) or ticket.get("number") is None:
            return Response(
                {"detail": "ticket{number,subject,status} is required"},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if not isinstance(recipients, list) or not all(
            isinstance(r, str) and r for r in recipients
        ):
            return Response(
                {"detail": "recipients[] of email strings is required"},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if not recipients:
            return Response(
                {"detail": "recipients[] must not be empty"},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if not isinstance(detail, str) or not detail.strip():
            return Response(
                {"detail": "detail string is required"},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        sent = send_ticket_event(
            event,
            ticket,
            recipients,
            detail.strip(),
            actor_email=actor_email if isinstance(actor_email, str) else None,
            ticket_url=ticket_url if isinstance(ticket_url, str) else None,
        )
        return Response({"ok": True, "sent": sent})
```

Import `send_ticket_event` in views. Register in `urls.py`:

```python
path(
    "v1/notify/ticket",
    TicketNotifyView.as_view(),
    name="notify-ticket",
),
```

- [ ] **Step 3: Run aw-auth tests for ticket notify**

```powershell
cd D:\Code\aw\aw-inventory\aw-auth
uv run pytest accounts/tests.py -q -k ticket
```

- [ ] **Step 4: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add aw-auth/accounts/views.py aw-auth/config/urls.py aw-auth/accounts/tests.py
git commit -m @"
feat(spec 33): POST /v1/notify/ticket endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 3: Web recipients helper + `sendTicketEmail`

**Files:**
- Create: `web/src/db/ticket-notify.ts`
- Create: `web/src/db/ticket-notify.test.ts`
- Modify: `web/src/lib/notify.ts`
- Modify: `web/src/lib/notify.test.ts`

**Interfaces:**
- Produces:
  - `ticketNotifyRecipients(ticket: { assigneeEmail?: string | null; requesterEmail?: string | null }, actorEmail: string, opts?: { includeRequester?: boolean }): string[]`
  - `sendTicketEmail(payload: TicketEmailPayload): Promise<boolean>`
  - `TicketEmailPayload = { event; ticket; recipients; detail; actorEmail?; ticketUrl? }`

- [ ] **Step 1: Failing recipient tests**

```ts
// web/src/db/ticket-notify.test.ts
import { describe, expect, it } from "vitest";
import { ticketNotifyRecipients } from "./ticket-notify";

describe("ticketNotifyRecipients", () => {
  it("returns assignee when different from actor", () => {
    expect(
      ticketNotifyRecipients(
        { assigneeEmail: "tech@co.com", requesterEmail: "user@co.com" },
        "admin@co.com",
      ),
    ).toEqual(["tech@co.com"]);
  });

  it("skips self (case-insensitive)", () => {
    expect(
      ticketNotifyRecipients(
        { assigneeEmail: "Admin@Co.com" },
        "admin@co.com",
      ),
    ).toEqual([]);
  });

  it("returns empty when no assignee", () => {
    expect(
      ticketNotifyRecipients({ assigneeEmail: null }, "admin@co.com"),
    ).toEqual([]);
  });

  it("includeRequester unions and dedupes (future seam)", () => {
    expect(
      ticketNotifyRecipients(
        { assigneeEmail: "tech@co.com", requesterEmail: "user@co.com" },
        "admin@co.com",
        { includeRequester: true },
      ),
    ).toEqual(["tech@co.com", "user@co.com"]);
    expect(
      ticketNotifyRecipients(
        { assigneeEmail: "same@co.com", requesterEmail: "same@co.com" },
        "admin@co.com",
        { includeRequester: true },
      ),
    ).toEqual(["same@co.com"]);
  });
});
```

- [ ] **Step 2: Implement helper + sendTicketEmail**

`ticket-notify.ts`:

```ts
export function ticketNotifyRecipients(
  ticket: {
    assigneeEmail?: string | null;
    requesterEmail?: string | null;
  },
  actorEmail: string,
  opts?: { includeRequester?: boolean },
): string[] {
  const actor = actorEmail.trim().toLowerCase();
  const out: string[] = [];
  const add = (email: string | null | undefined) => {
    const e = email?.trim();
    if (!e) return;
    if (e.toLowerCase() === actor) return;
    if (out.some((x) => x.toLowerCase() === e.toLowerCase())) return;
    out.push(e);
  };
  add(ticket.assigneeEmail);
  if (opts?.includeRequester) add(ticket.requesterEmail);
  return out;
}
```

In `notify.ts`, add (mirror `sendReportEmail`):

```ts
export type TicketEmailPayload = {
  event: "assigned" | "comment" | "status";
  ticket: {
    id: string;
    number: number;
    subject: string;
    status: string;
    priority?: string;
    assigneeEmail?: string | null;
  };
  recipients: string[];
  detail: string;
  actorEmail?: string;
  ticketUrl?: string;
};

export async function sendTicketEmail(
  payload: TicketEmailPayload,
): Promise<boolean> {
  const who = `#${payload.ticket.number} (${payload.event})`;
  try {
    const token = await getServiceToken();
    if (!token) return false;
    if (!payload.recipients.length) return false;

    const res = await fetch(`${AUTH_API_URL}/v1/notify/ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (res.status === 401) cachedToken = null;
    if (!res.ok) {
      console.error(
        `[notify] ticket ${who} ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
      return false;
    }
    const data = (await res.json().catch(() => null)) as { sent?: boolean } | null;
    return data?.sent === true;
  } catch (err) {
    console.error(`[notify] ticket email failed for ${who}:`, err);
    return false;
  }
}
```

Add notify.test.ts cases for `sendTicketEmail` (sent true / sent false / no creds) using the same `mockFetch` pattern; assert URL contains `/v1/notify/ticket`.

- [ ] **Step 3: Run — PASS**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/db/ticket-notify.test.ts src/lib/notify.test.ts --run
```

- [ ] **Step 4: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/ticket-notify.ts web/src/db/ticket-notify.test.ts web/src/lib/notify.ts web/src/lib/notify.test.ts
git commit -m @"
feat(spec 33): ticket notify recipients + sendTicketEmail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

### Task 4: Wire update + comment → notify

**Files:**
- Modify: `web/src/db/ticket-notify.ts` (add `maybeNotifyTicketUpdate` / `maybeNotifyTicketComment`)
- Modify: `web/src/db/tickets.ts` (`updateTicket` / `addTicketComment` signatures to accept `actorEmail` **or** wire only from actions — prefer **actions** calling helpers after write so DB layer stays free of notify; if helpers need before/after, load in actions)
- Modify: `web/src/app/(app)/ticket-actions.ts`
- Modify: `web/src/app/(app)/ticket-actions.test.ts`
- Modify: `web/src/db/ticket-notify.test.ts`

**Interfaces:**
- Prefer wiring in **server actions** (they already have `user.email`):
  1. `getTicket(id)` before update
  2. `updateTicket` / `addTicketComment`
  3. `void maybeNotify...` (do not await blocking UX longer than needed — **await** is OK if send is fast; design allows either; **await** with try/catch inside helper so action still returns ok)
- `WEB_PUBLIC_URL` env (document in `web/.env.example`): if set, `ticketUrl = ${WEB_PUBLIC_URL.replace(/\/$/, "")}/tickets/${id}`

- [ ] **Step 1: Failing helper tests**

```ts
// mock sendTicketEmail
const sendMock = vi.fn();
vi.mock("@/lib/notify", () => ({ sendTicketEmail: (...a: unknown[]) => sendMock(...a) }));

it("notifies assigned when assignee changes to non-null", async () => {
  sendMock.mockResolvedValue(true);
  await maybeNotifyTicketUpdate({
    before: { id: "t1", number: 1, subject: "S", status: "open", assigneeEmail: null, requesterEmail: null },
    after: { id: "t1", number: 1, subject: "S", status: "open", assigneeEmail: "tech@co.com", requesterEmail: null },
    patch: { assigneeEmail: "tech@co.com" },
    actorEmail: "admin@co.com",
  });
  expect(sendMock).toHaveBeenCalledWith(
    expect.objectContaining({ event: "assigned", recipients: ["tech@co.com"] }),
  );
});

it("notifies status when status changes", async () => { /* ... */ });

it("skips comment notify for system kind", async () => {
  await maybeNotifyTicketComment({
    ticket: { id: "t1", number: 1, subject: "S", status: "open", assigneeEmail: "tech@co.com", requesterEmail: null },
    actorEmail: "admin@co.com",
    body: "sys",
    kind: "system",
  });
  expect(sendMock).not.toHaveBeenCalled();
});

it("sends two emails when assignee and status both change", async () => {
  /* expect sendMock twice: assigned + status */
});
```

- [ ] **Step 2: Implement helpers**

```ts
const COMMENT_MAX = 2000;

export async function maybeNotifyTicketUpdate(input: {
  before: TicketNotifySnapshot;
  after: TicketNotifySnapshot;
  patch: { assigneeEmail?: string | null; status?: string };
  actorEmail: string;
}): Promise<void> {
  const { before, after, patch, actorEmail } = input;
  const base = {
    ticket: {
      id: after.id,
      number: after.number,
      subject: after.subject,
      status: after.status,
      assigneeEmail: after.assigneeEmail,
    },
    actorEmail,
    ticketUrl: publicTicketUrl(after.id),
  };
  try {
    if (
      "assigneeEmail" in patch &&
      patch.assigneeEmail !== before.assigneeEmail &&
      after.assigneeEmail
    ) {
      const recipients = ticketNotifyRecipients(after, actorEmail);
      if (recipients.length) {
        await sendTicketEmail({
          ...base,
          event: "assigned",
          recipients,
          detail: `Assigned to ${after.assigneeEmail}`,
        });
      }
    }
    if ("status" in patch && patch.status !== undefined && patch.status !== before.status) {
      const recipients = ticketNotifyRecipients(after, actorEmail);
      if (recipients.length) {
        await sendTicketEmail({
          ...base,
          event: "status",
          recipients,
          detail: `${before.status} → ${after.status}`,
        });
      }
    }
  } catch (err) {
    console.error("[ticket-notify] update failed:", err);
  }
}

export async function maybeNotifyTicketComment(input: {
  ticket: TicketNotifySnapshot;
  actorEmail: string;
  body: string;
  kind: "user" | "system";
}): Promise<void> {
  if (input.kind !== "user") return;
  try {
    const recipients = ticketNotifyRecipients(input.ticket, input.actorEmail);
    if (!recipients.length) return;
    const detail = input.body.trim().slice(0, COMMENT_MAX);
    await sendTicketEmail({
      event: "comment",
      ticket: {
        id: input.ticket.id,
        number: input.ticket.number,
        subject: input.ticket.subject,
        status: input.ticket.status,
        assigneeEmail: input.ticket.assigneeEmail,
      },
      recipients,
      detail,
      actorEmail: input.actorEmail,
      ticketUrl: publicTicketUrl(input.ticket.id),
    });
  } catch (err) {
    console.error("[ticket-notify] comment failed:", err);
  }
}

function publicTicketUrl(id: string): string | undefined {
  const base = (process.env.WEB_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
  return base ? `${base}/tickets/${id}` : undefined;
}
```

Define `TicketNotifySnapshot` with id, number, subject, status, assigneeEmail, requesterEmail.

- [ ] **Step 3: Wire actions**

In `updateTicketAction`: before update, `const before = await getTicket(id)`; after success, reload or merge patch into snapshot; call `maybeNotifyTicketUpdate`. Only pass `assigneeEmail` / `status` keys that were in `parsed.data`.

In `addTicketCommentAction`: after comment, `getTicket`, then `maybeNotifyTicketComment({ ..., kind: "user" })`.

- [ ] **Step 4: Action tests** — mock `@/db/ticket-notify` or `@/lib/notify`; assert called / not called for self-assign.

- [ ] **Step 5: Run tests**

```powershell
cd D:\Code\aw\aw-inventory\web
npm test -- src/db/ticket-notify.test.ts "src/app/(app)/ticket-actions.test.ts" --run
```

- [ ] **Step 6: Commit**

```powershell
cd D:\Code\aw\aw-inventory
git add web/src/db/ticket-notify.ts web/src/db/ticket-notify.test.ts "web/src/app/(app)/ticket-actions.ts" "web/src/app/(app)/ticket-actions.test.ts" web/.env.example
git commit -m @"
feat(spec 33): email assignee on ticket assign comment status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

Add to `web/.env.example`:

```
# Optional absolute origin for ticket email deep links (e.g. https://inventory.example)
# WEB_PUBLIC_URL=http://localhost:3000
```

---

### Task 5: Docs

**Files:**
- Modify: `docs/specs/33-ticketing/index.md` — promote outbound under phases / note shipped on branch
- Modify: `PROGRESS.md` — keep 🚧 until merge; ensure design link present
- Modify: design Status → implemented on branch
- Out of scope line: clarify email-in still parked; outbound in progress/shipped

- [ ] **Step 1: Update Spec 33 phases**

```md
3. **v2.5 — outbound ticket email** — [design](../../superpowers/specs/2026-10-21-outbound-ticket-email-design.md):
   assignee notified on assign / user comment / status via aw-auth + Resend
   (shipped on feat/spec-33-outbound-ticket-email).
4. **Later** — email-in; end-user portal.
```

- [ ] **Step 2: Design status + commit**

```powershell
cd D:\Code\aw\aw-inventory
git add docs/specs/33-ticketing/index.md PROGRESS.md docs/superpowers/specs/2026-10-21-outbound-ticket-email-design.md
git commit -m @"
docs(spec 33): mark outbound ticket email implemented on branch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
"@
```

---

## Spec coverage

| AC | Task |
|---|---|
| AC-E1 assigned | Task 4 |
| AC-E2 comment | Task 4 |
| AC-E3 status | Task 4 |
| AC-E4 no system / no create | Task 4 |
| AC-E5 empty recipients | Task 1–4 |
| AC-E6 failure non-blocking | Task 3–4 try/catch |
| AC-E7 explicit recipients | Task 1–2 |

## Placeholder scan

None intentional. Implementers resolve APIClient vs RequestFactory for Task 2 against existing aw-auth notify tests.

## Type consistency

`assigned` | `comment` | `status`; `recipients[]`; `ticketNotifyRecipients` / `sendTicketEmail` / `maybeNotifyTicketUpdate` / `maybeNotifyTicketComment`.
