import type { TicketPriority, TicketStatus } from "@/lib/data";
import { ticketSlaState } from "@/lib/ticket-sla";

/** Labels and badge variants for the tickets UI (spec 33). */

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_user: "Waiting on user",
  resolved: "Resolved",
  closed: "Closed",
};

export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Fixed ticket categories — UI select only (no free text). */
export const TICKET_CATEGORIES = [
  "General",
  "Hardware",
  "Software",
  "Network",
  "Printer",
  "Security",
  "Patching",
  "Maintenance",
  "Request",
  "Alert",
  "Warranty",
  "Discovery",
  "Scan",
  "Ops",
  "Assist",
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export function isTicketCategory(value: string): value is TicketCategory {
  return (TICKET_CATEGORIES as readonly string[]).includes(value);
}

export function ticketStatusVariant(
  status: TicketStatus,
): "outline" | "secondary" | "destructive" | "default" {
  if (status === "open") return "default";
  if (status === "in_progress") return "secondary";
  if (status === "waiting_on_user") return "secondary";
  if (status === "resolved") return "outline";
  return "outline";
}

export function ticketPriorityVariant(
  priority: TicketPriority,
): "outline" | "secondary" | "destructive" {
  if (priority === "high") return "destructive";
  if (priority === "medium") return "secondary";
  return "outline";
}

export function ticketNumberLabel(number: number): string {
  return `TKT-${number}`;
}

export function assigneeLabel(email: string | null | undefined): string {
  if (!email) return "Unassigned";
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return email.slice(0, at);
}

/** Display email for the person the ticket is about. */
export function requesterEmailOf(ticket: {
  requesterEmail: string | null;
  createdBy: string;
}): string {
  return ticket.requesterEmail?.trim() || ticket.createdBy;
}

export function requesterLabel(ticket: {
  requesterEmail: string | null;
  createdBy: string;
}): string {
  return assigneeLabel(requesterEmailOf(ticket));
}

export function categoryLabel(category: string): string {
  const trimmed = category.trim();
  return trimmed || "General";
}

export function ticketKpiCounts(
  rows: {
    status: TicketStatus;
    priority: TicketPriority;
    createdAt: string;
  }[],
  now: Date = new Date(),
): {
  open: number;
  inProgress: number;
  waiting: number;
  resolved: number;
  slaBreached: number;
} {
  const out = {
    open: 0,
    inProgress: 0,
    waiting: 0,
    resolved: 0,
    slaBreached: 0,
  };
  for (const r of rows) {
    if (r.status === "open") out.open += 1;
    else if (r.status === "in_progress") out.inProgress += 1;
    else if (r.status === "waiting_on_user") out.waiting += 1;
    else if (r.status === "resolved") out.resolved += 1;
    if (ticketSlaState(r, now).kind === "breached") out.slaBreached += 1;
  }
  return out;
}
