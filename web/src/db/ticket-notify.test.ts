import { describe, expect, it } from "vitest";
import { ticketNotifyRecipients } from "./ticket-notify";

describe("ticketNotifyRecipients", () => {
  it("returns assignee when different from actor", () => {
    expect(
      ticketNotifyRecipients(
        { assigneeEmail: "tech@co.com", requesterEmail: "user@co.com" },
        "admin@co.com",
      ),
    ).toEqual(["tech@co.com"]);
  });

  it("skips self (case-insensitive)", () => {
    expect(
      ticketNotifyRecipients(
        { assigneeEmail: "Admin@Co.com" },
        "admin@co.com",
      ),
    ).toEqual([]);
  });

  it("returns empty when no assignee", () => {
    expect(
      ticketNotifyRecipients({ assigneeEmail: null }, "admin@co.com"),
    ).toEqual([]);
  });

  it("includeRequester unions and dedupes (future seam)", () => {
    expect(
      ticketNotifyRecipients(
        { assigneeEmail: "tech@co.com", requesterEmail: "user@co.com" },
        "admin@co.com",
        { includeRequester: true },
      ),
    ).toEqual(["tech@co.com", "user@co.com"]);
    expect(
      ticketNotifyRecipients(
        { assigneeEmail: "same@co.com", requesterEmail: "same@co.com" },
        "admin@co.com",
        { includeRequester: true },
      ),
    ).toEqual(["same@co.com"]);
  });
});
