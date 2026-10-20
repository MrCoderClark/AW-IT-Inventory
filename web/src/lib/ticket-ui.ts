import type { TicketPriority, TicketStatus } from "@/lib/data";

/** Labels and badge variants for the tickets UI (spec 33). */

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function ticketStatusVariant(
  status: TicketStatus,
): "outline" | "secondary" | "destructive" | "default" {
  if (status === "open") return "default";
  if (status === "in_progress") return "secondary";
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

export function categoryLabel(category: string): string {
  const trimmed = category.trim();
  return trimmed || "General";
}

export function ticketKpiCounts(
  rows: { status: TicketStatus }[],
): { open: number; inProgress: number; closed: number; resolved: number } {
  const out = { open: 0, inProgress: 0, closed: 0, resolved: 0 };
  for (const r of rows) {
    if (r.status === "open") out.open += 1;
    else if (r.status === "in_progress") out.inProgress += 1;
    else if (r.status === "closed") out.closed += 1;
    else if (r.status === "resolved") out.resolved += 1;
  }
  return out;
}
