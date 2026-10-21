import "server-only";

import { sendTicketEmail } from "@/lib/notify";

const COMMENT_MAX = 2000;

export type TicketNotifySnapshot = {
  id: string;
  number: number;
  subject: string;
  status: string;
  assigneeEmail?: string | null;
  requesterEmail?: string | null;
};

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
    if (
      "status" in patch &&
      patch.status !== undefined &&
      patch.status !== before.status
    ) {
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
