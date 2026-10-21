import "server-only";

import { and, eq } from "drizzle-orm";

import {
  extractInReplyTo,
  normalizeEmailAddress,
  parseTicketNumberFromSubject,
  stripQuotedReply,
} from "@/lib/email-inbound";

import { db } from "./index";
import { ticketEmailMessages, tickets } from "./schema";
import { addTicketComment, getTicket } from "./tickets";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Same check as `tickets.ts`: postgres.js exposes SQLSTATE on `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
}

/**
 * Spec 33 Message-ID store. Outbound sends and inbound replies share one
 * unique message id so a reply can be matched and a duplicate webhook ignored.
 */

export type TicketEmailDirection = "outbound" | "inbound";

export type RecordTicketEmailMessageInput = {
  ticketId: string;
  direction: TicketEmailDirection;
  messageId: string;
  inReplyTo?: string | null;
  fromEmail?: string | null;
};

export async function recordTicketEmailMessage(
  input: RecordTicketEmailMessageInput,
  tx?: Tx,
): Promise<void> {
  const q = (tx ?? db) as typeof db;
  await q.insert(ticketEmailMessages).values({
    ticketId: input.ticketId,
    direction: input.direction,
    messageId: input.messageId,
    inReplyTo: input.inReplyTo ?? null,
    fromEmail: input.fromEmail ?? null,
  });
}

/** Ticket that owns this Message-ID, outbound or inbound. */
export async function findTicketIdByMessageId(
  messageId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ ticketId: ticketEmailMessages.ticketId })
    .from(ticketEmailMessages)
    .where(eq(ticketEmailMessages.messageId, messageId))
    .limit(1);
  return row?.ticketId ?? null;
}

/** True when this Message-ID was already stored as an inbound reply. */
export async function inboundMessageExists(
  messageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ticketEmailMessages.id })
    .from(ticketEmailMessages)
    .where(
      and(
        eq(ticketEmailMessages.messageId, messageId),
        eq(ticketEmailMessages.direction, "inbound"),
      ),
    )
    .limit(1);
  return row != null;
}

/** Ticket fields the inbound matcher needs, looked up by the `[#N]` number. */
export async function getTicketByNumber(number: number) {
  const [row] = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      assigneeEmail: tickets.assigneeEmail,
      requesterEmail: tickets.requesterEmail,
      subject: tickets.subject,
      status: tickets.status,
    })
    .from(tickets)
    .where(eq(tickets.number, number))
    .limit(1);
  return row ?? null;
}

export type InboundEmail = {
  emailId: string;
  messageId: string;
  from: string;
  subject: string;
  text: string | null;
  html: string | null;
  headers?: Record<string, string>;
};

export type ProcessInboundEmailResult =
  | { status: "commented" }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/** Tag-stripping fallback when a reply has HTML and no text part. */
function htmlToTextRough(html: string | null): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Reply-only inbound mail. Matches an existing ticket, authorizes the sender,
 * then inserts the inbound Message-ID and the comment in one transaction.
 * A unique-violation on that insert is a duplicate. Notify runs only after commit.
 */
export async function processInboundEmail(
  mail: InboundEmail,
): Promise<ProcessInboundEmailResult> {
  if (!mail.messageId) return { status: "ignored", reason: "no_message_id" };
  if (await inboundMessageExists(mail.messageId)) {
    return { status: "duplicate" };
  }

  const from = normalizeEmailAddress(mail.from);
  const inReplyTo = extractInReplyTo(mail.headers);
  let ticketId =
    (await findTicketIdByMessageId(inReplyTo ?? "")) ?? null;

  if (!ticketId) {
    const n = parseTicketNumberFromSubject(mail.subject);
    if (n != null) {
      const t = await getTicketByNumber(n);
      ticketId = t?.id ?? null;
    }
  }
  if (!ticketId) return { status: "ignored", reason: "no_ticket" };

  const ticket = await getTicket(ticketId);
  if (!ticket) return { status: "ignored", reason: "no_ticket" };

  const allowed = [ticket.assigneeEmail, ticket.requesterEmail]
    .filter(Boolean)
    .map((e) => e!.trim().toLowerCase());
  if (!allowed.includes(from)) {
    return { status: "ignored", reason: "unauthorized" };
  }

  const raw = mail.text?.trim() || htmlToTextRough(mail.html) || "";
  const body = stripQuotedReply(raw);
  if (!body) return { status: "ignored", reason: "empty_body" };

  try {
    await db.transaction(async (tx) => {
      await recordTicketEmailMessage(
        {
          ticketId: ticket.id,
          direction: "inbound",
          messageId: mail.messageId,
          inReplyTo,
          fromEmail: from,
        },
        tx,
      );
      const commentId = await addTicketComment(
        ticket.id,
        {
          authorEmail: from,
          body,
          kind: "user",
        },
        tx,
      );
      // Null means the comment was not stored. Throw so the Message-ID insert
      // rolls back with it; a committed id without a comment would swallow retries.
      if (!commentId) {
        throw new Error("inbound comment was not stored");
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "duplicate" };
    throw err;
  }

  // Dynamic import: ticket-notify records outbound ids through this module.
  // After commit only — a notify failure must not roll back the comment.
  const { maybeNotifyTicketComment } = await import("./ticket-notify");
  await maybeNotifyTicketComment({
    ticket: {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      assigneeEmail: ticket.assigneeEmail,
      requesterEmail: ticket.requesterEmail,
    },
    actorEmail: from,
    body,
    kind: "user",
  });

  return { status: "commented" };
}
