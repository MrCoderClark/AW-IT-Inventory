import type { TicketListItem } from "@/lib/data";
import { ticketSlaState } from "@/lib/ticket-sla";
import {
  categoryLabel,
  requesterLabel,
  ticketNumberLabel,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
} from "@/lib/ticket-ui";

const HEADERS = [
  "Ticket ID",
  "Subject",
  "Asset",
  "Location",
  "Category",
  "Priority",
  "Status",
  "SLA",
  "Assignee",
  "Requester",
  "Created",
] as const;

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function ticketCsvCells(t: TicketListItem, now: Date): string[] {
  return [
    ticketNumberLabel(t.number),
    t.subject,
    t.assetTag ?? "",
    t.locationLabel ?? "",
    categoryLabel(t.category),
    TICKET_PRIORITY_LABEL[t.priority],
    TICKET_STATUS_LABEL[t.status],
    ticketSlaState(t, now).label,
    t.assigneeEmail ?? "",
    requesterLabel(t),
    t.createdAt,
  ];
}

/** RFC 4180 CSV for ticket list export (spec 33 v2). Caller passes filtered rows. */
export function ticketsToCsv(rows: TicketListItem[], now: Date = new Date()): string {
  const lines = [HEADERS.map((h) => csvField(h)).join(",")];
  for (const t of rows) {
    lines.push(ticketCsvCells(t, now).map(csvField).join(","));
  }
  return lines.join("\r\n");
}
