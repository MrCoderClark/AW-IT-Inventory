import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, recordMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({
  sendTicketEmail: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("@/db/ticket-email", () => ({
  recordTicketEmailMessage: (...args: unknown[]) => recordMock(...args),
}));

import {
  maybeNotifyTicketComment,
  maybeNotifyTicketUpdate,
  ticketNotifyRecipients,
} from "./ticket-notify";

const SNAPSHOT = {
  id: "t1",
  number: 1,
  subject: "S",
  status: "open",
  assigneeEmail: null as string | null,
  requesterEmail: null as string | null,
};

function snap(
  over: Partial<typeof SNAPSHOT> = {},
): typeof SNAPSHOT {
  return { ...SNAPSHOT, ...over };
}

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

describe("maybeNotifyTicketUpdate", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue(true);
    recordMock.mockReset();
    recordMock.mockResolvedValue(undefined);
    delete process.env.WEB_PUBLIC_URL;
  });

  afterEach(() => {
    delete process.env.WEB_PUBLIC_URL;
  });

  it("notifies assigned when assignee changes to non-null", async () => {
    await maybeNotifyTicketUpdate({
      before: snap(),
      after: snap({ assigneeEmail: "tech@co.com" }),
      patch: { assigneeEmail: "tech@co.com" },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "assigned",
        recipients: ["tech@co.com"],
        detail: "Assigned to tech@co.com",
        actorEmail: "admin@co.com",
        ticket: expect.objectContaining({
          id: "t1",
          number: 1,
          subject: "S",
          status: "open",
          assigneeEmail: "tech@co.com",
        }),
      }),
    );
  });

  it("notifies status when status changes", async () => {
    await maybeNotifyTicketUpdate({
      before: snap({ assigneeEmail: "tech@co.com" }),
      after: snap({ assigneeEmail: "tech@co.com", status: "closed" }),
      patch: { status: "closed" },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "status",
        recipients: ["tech@co.com"],
        detail: "open → closed",
      }),
    );
  });

  it("sends two emails when assignee and status both change", async () => {
    await maybeNotifyTicketUpdate({
      before: snap(),
      after: snap({ assigneeEmail: "tech@co.com", status: "in_progress" }),
      patch: { assigneeEmail: "tech@co.com", status: "in_progress" },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: "assigned",
        recipients: ["tech@co.com"],
      }),
    );
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "status",
        recipients: ["tech@co.com"],
        detail: "open → in_progress",
      }),
    );
  });

  it("skips assigned notify when the actor is the new assignee", async () => {
    await maybeNotifyTicketUpdate({
      before: snap(),
      after: snap({ assigneeEmail: "admin@co.com" }),
      patch: { assigneeEmail: "admin@co.com" },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when the assignee is cleared", async () => {
    await maybeNotifyTicketUpdate({
      before: snap({ assigneeEmail: "tech@co.com" }),
      after: snap({ assigneeEmail: null }),
      patch: { assigneeEmail: null },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not notify when assignee and status are unchanged", async () => {
    await maybeNotifyTicketUpdate({
      before: snap({ assigneeEmail: "tech@co.com" }),
      after: snap({ assigneeEmail: "tech@co.com" }),
      patch: { assigneeEmail: "tech@co.com", status: "open" },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("includes a public ticket url when WEB_PUBLIC_URL is set", async () => {
    process.env.WEB_PUBLIC_URL = "https://inventory.example/";
    await maybeNotifyTicketUpdate({
      before: snap({ assigneeEmail: "tech@co.com" }),
      after: snap({ assigneeEmail: "tech@co.com", status: "closed" }),
      patch: { status: "closed" },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketUrl: "https://inventory.example/tickets/t1",
      }),
    );
  });

  it("omits ticket url when WEB_PUBLIC_URL is blank", async () => {
    process.env.WEB_PUBLIC_URL = "   ";
    await maybeNotifyTicketUpdate({
      before: snap({ assigneeEmail: "tech@co.com" }),
      after: snap({ assigneeEmail: "tech@co.com", status: "closed" }),
      patch: { status: "closed" },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ ticketUrl: undefined }),
    );
  });

  it("records an outbound message id after a successful send", async () => {
    sendMock.mockResolvedValue({ sent: true, messageId: "re_abc" });
    await maybeNotifyTicketUpdate({
      before: snap(),
      after: snap({ assigneeEmail: "tech@co.com" }),
      patch: { assigneeEmail: "tech@co.com" },
      actorEmail: "admin@co.com",
    });
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith({
      ticketId: "t1",
      direction: "outbound",
      messageId: "re_abc",
    });
  });

  it("does not record when the send has no message id", async () => {
    sendMock.mockResolvedValue({ sent: true });
    await maybeNotifyTicketUpdate({
      before: snap({ assigneeEmail: "tech@co.com" }),
      after: snap({ assigneeEmail: "tech@co.com", status: "closed" }),
      patch: { status: "closed" },
      actorEmail: "admin@co.com",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("does not record when the send was not delivered", async () => {
    sendMock.mockResolvedValue({ sent: false, messageId: "re_abc" });
    await maybeNotifyTicketUpdate({
      before: snap({ assigneeEmail: "tech@co.com" }),
      after: snap({ assigneeEmail: "tech@co.com", status: "closed" }),
      patch: { status: "closed" },
      actorEmail: "admin@co.com",
    });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("swallows send failures so the caller still resolves", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      maybeNotifyTicketUpdate({
        before: snap({ assigneeEmail: "tech@co.com" }),
        after: snap({ assigneeEmail: "tech@co.com", status: "closed" }),
        patch: { status: "closed" },
        actorEmail: "admin@co.com",
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("maybeNotifyTicketComment", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue(true);
    recordMock.mockReset();
    recordMock.mockResolvedValue(undefined);
    delete process.env.WEB_PUBLIC_URL;
  });

  it("skips comment notify for system kind", async () => {
    await maybeNotifyTicketComment({
      ticket: snap({ assigneeEmail: "tech@co.com" }),
      actorEmail: "admin@co.com",
      body: "sys",
      kind: "system",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("notifies the assignee on a user comment and caps the body", async () => {
    const body = `  ${"x".repeat(2001)}  `;
    await maybeNotifyTicketComment({
      ticket: snap({ assigneeEmail: "tech@co.com" }),
      actorEmail: "admin@co.com",
      body,
      kind: "user",
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "comment",
        recipients: ["tech@co.com"],
        detail: "x".repeat(2000),
        actorEmail: "admin@co.com",
      }),
    );
  });

  it("skips a user comment when the actor is the assignee", async () => {
    await maybeNotifyTicketComment({
      ticket: snap({ assigneeEmail: "Admin@Co.com" }),
      actorEmail: "admin@co.com",
      body: "note",
      kind: "user",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("records an outbound message id after a user comment is sent", async () => {
    sendMock.mockResolvedValue({ sent: true, messageId: "re_cmt" });
    await maybeNotifyTicketComment({
      ticket: snap({ assigneeEmail: "tech@co.com" }),
      actorEmail: "admin@co.com",
      body: "hello",
      kind: "user",
    });
    expect(recordMock).toHaveBeenCalledWith({
      ticketId: "t1",
      direction: "outbound",
      messageId: "re_cmt",
    });
  });

  it("swallows comment send failures", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      maybeNotifyTicketComment({
        ticket: snap({ assigneeEmail: "tech@co.com" }),
        actorEmail: "admin@co.com",
        body: "hello",
        kind: "user",
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
