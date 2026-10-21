import { describe, expect, it } from "vitest";

import {
  assigneeLabel,
  categoryLabel,
  isTicketCategory,
  requesterEmailOf,
  requesterLabel,
  ticketKpiCounts,
  ticketNumberLabel,
  TICKET_CATEGORIES,
} from "@/lib/ticket-ui";

describe("ticket-ui helpers", () => {
  it("formats ticket numbers and empty categories", () => {
    expect(ticketNumberLabel(42)).toBe("TKT-42");
    expect(categoryLabel("")).toBe("General");
    expect(categoryLabel(" Alert ")).toBe("Alert");
  });

  it("exposes a fixed category list", () => {
    expect(TICKET_CATEGORIES).toContain("General");
    expect(TICKET_CATEGORIES).toContain("Hardware");
    expect(isTicketCategory("Hardware")).toBe(true);
    expect(isTicketCategory("CustomStuff")).toBe(false);
  });

  it("labels assignees", () => {
    expect(assigneeLabel(null)).toBe("Unassigned");
    expect(assigneeLabel("jane.doe@example.com")).toBe("jane.doe");
  });

  it("resolves requester from requesterEmail or createdBy", () => {
    expect(
      requesterEmailOf({
        requesterEmail: "owner@example.com",
        createdBy: "admin@example.com",
      }),
    ).toBe("owner@example.com");
    expect(
      requesterLabel({
        requesterEmail: null,
        createdBy: "admin@example.com",
      }),
    ).toBe("admin");
  });

  it("counts KPI buckets including SLA breached", () => {
    const now = new Date("2026-10-21T18:00:00.000Z");
    expect(
      ticketKpiCounts(
        [
          {
            status: "open",
            priority: "high",
            createdAt: "2026-10-21T12:00:00.000Z", // due 16:00 → breached
          },
          {
            status: "open",
            priority: "high",
            createdAt: "2026-10-21T16:00:00.000Z", // due 20:00 → ok
          },
          {
            status: "in_progress",
            priority: "medium",
            createdAt: "2026-10-21T12:00:00.000Z",
          },
          {
            status: "waiting_on_user",
            priority: "high",
            createdAt: "2026-10-20T00:00:00.000Z", // paused, not breached
          },
          {
            status: "resolved",
            priority: "high",
            createdAt: "2026-10-20T00:00:00.000Z",
          },
          {
            status: "resolved",
            priority: "low",
            createdAt: "2026-10-20T00:00:00.000Z",
          },
          {
            status: "closed",
            priority: "high",
            createdAt: "2026-10-20T00:00:00.000Z",
          },
        ],
        now,
      ),
    ).toEqual({
      open: 2,
      inProgress: 1,
      waiting: 1,
      resolved: 2,
      slaBreached: 1,
    });
  });
});
