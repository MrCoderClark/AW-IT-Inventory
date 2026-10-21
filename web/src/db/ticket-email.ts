import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "./index";
import { ticketEmailMessages, tickets } from "./schema";

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
): Promise<void> {
  await db.insert(ticketEmailMessages).values({
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
