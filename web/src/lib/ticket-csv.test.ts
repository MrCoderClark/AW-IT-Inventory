import { describe, expect, it } from "vitest";

import type { TicketListItem } from "@/lib/data";
import { ticketsToCsv } from "@/lib/ticket-csv";

const CSV_NOW = new Date("2026-10-21T17:04:00.000Z");

function row(partial: Partial<TicketListItem> & Pick<TicketListItem, "number" | "subject">): TicketListItem {
  return {
    id: partial.id ?? "id-1",
    number: partial.number,
    subject: partial.subject,
    description: partial.description ?? "",
    status: partial.status ?? "open",
    priority: partial.priority ?? "medium",
    category: partial.category ?? "Hardware",
    assigneeEmail: partial.assigneeEmail ?? null,
    requesterEmail: partial.requesterEmail ?? null,
    assetId: partial.assetId ?? null,
    assetTag: partial.assetTag ?? null,
    assetName: partial.assetName ?? null,
    locationLabel: partial.locationLabel ?? null,
    sourceNotificationId: partial.sourceNotificationId ?? null,
    createdBy: partial.createdBy ?? "admin@example.com",
    createdAt: partial.createdAt ?? "2026-10-21T16:04:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-10-21T16:04:00.000Z",
  };
}

describe("ticketsToCsv", () => {
  it("emits header and one data row with human labels", () => {
    const csv = ticketsToCsv(
      [
        row({
          number: 1042,
          subject: "Disk low",
          status: "waiting_on_user",
          priority: "high",
          category: "Alert",
          assetTag: "7192FK2",
          locationLabel: "NYC",
          assigneeEmail: "jc@example.com",
          requesterEmail: "user@example.com",
          createdAt: "2026-10-21T16:04:00.000Z",
        }),
      ],
      CSV_NOW,
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Ticket ID,Subject,Asset,Location,Category,Priority,Status,SLA,Assignee,Requester,Created",
    );
    expect(lines[1]).toBe(
      "TKT-1042,Disk low,7192FK2,NYC,Alert,High,Waiting on user,Paused,jc@example.com,user,2026-10-21T16:04:00.000Z",
    );
  });

  it("escapes commas and quotes per RFC 4180", () => {
    const csv = ticketsToCsv(
      [
        row({
          number: 1,
          subject: 'Say "hello", world',
        }),
      ],
      CSV_NOW,
    );
    expect(csv.split("\r\n")[1]).toContain('"Say ""hello"", world"');
  });

  it("exports every filtered row even when more than one page worth", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ number: i + 1, subject: `T${i + 1}`, id: `id-${i + 1}` }),
    );
    const lines = ticketsToCsv(rows, CSV_NOW).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(13); // header + 12
  });

  it("uses empty cells for missing asset/assignee/location", () => {
    const line = ticketsToCsv(
      [row({ number: 2, subject: "No asset", createdBy: "admin@example.com" })],
      CSV_NOW,
    ).split("\r\n")[1];
    // Asset, Location empty; Assignee empty; Requester from createdBy → "admin"
    expect(line).toBe(
      "TKT-2,No asset,,,Hardware,Medium,Open,7h left,,admin,2026-10-21T16:04:00.000Z",
    );
  });
});
