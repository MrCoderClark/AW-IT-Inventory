import type { TicketPriority, TicketStatus } from "@/lib/data";

export const TICKET_SLA_BUDGET_MS: Record<TicketPriority, number> = {
  high: 4 * 60 * 60 * 1000,
  medium: 8 * 60 * 60 * 1000,
  low: 24 * 60 * 60 * 1000,
};

export type TicketSlaKind = "none" | "paused" | "ok" | "breached";

export type TicketSlaState = {
  kind: TicketSlaKind;
  dueAt: Date | null;
  label: string;
};

/** Human remaining for positive ms: whole hours if ≥1h, else minutes (min 1m). */
export function formatSlaRemaining(ms: number): string {
  if (ms >= 60 * 60 * 1000) {
    return `${Math.floor(ms / (60 * 60 * 1000))}h left`;
  }
  return `${Math.max(1, Math.ceil(ms / (60 * 1000)))}m left`;
}

export function ticketSlaState(
  ticket: {
    createdAt: string;
    priority: TicketPriority;
    status: TicketStatus;
  },
  now: Date = new Date(),
): TicketSlaState {
  if (ticket.status === "resolved" || ticket.status === "closed") {
    return { kind: "none", dueAt: null, label: "—" };
  }

  const created = new Date(ticket.createdAt);
  const dueAt = new Date(created.getTime() + TICKET_SLA_BUDGET_MS[ticket.priority]);

  if (ticket.status === "waiting_on_user") {
    return { kind: "paused", dueAt, label: "Paused" };
  }

  const remaining = dueAt.getTime() - now.getTime();
  if (remaining <= 0) {
    return { kind: "breached", dueAt, label: "Overdue" };
  }
  return { kind: "ok", dueAt, label: formatSlaRemaining(remaining) };
}
