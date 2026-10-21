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
});

it("counts KPI buckets", () => {
  expect(
    ticketKpiCounts([
      { status: "open" },
      { status: "open" },
      { status: "in_progress" },
      { status: "waiting_on_user" },
      { status: "resolved" },
      { status: "resolved" },
      { status: "closed" },
    ]),
  ).toEqual({ open: 2, inProgress: 1, waiting: 1, resolved: 2 });
});
