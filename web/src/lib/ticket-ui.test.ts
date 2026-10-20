import { describe, expect, it } from "vitest";

import {
  assigneeLabel,
  categoryLabel,
  ticketNumberLabel,
} from "@/lib/ticket-ui";

describe("ticket-ui helpers", () => {
  it("formats ticket numbers and empty categories", () => {
    expect(ticketNumberLabel(42)).toBe("TKT-42");
    expect(categoryLabel("")).toBe("General");
    expect(categoryLabel(" Alert ")).toBe("Alert");
  });

  it("labels assignees", () => {
    expect(assigneeLabel(null)).toBe("Unassigned");
    expect(assigneeLabel("jane.doe@example.com")).toBe("jane.doe");
  });
});
