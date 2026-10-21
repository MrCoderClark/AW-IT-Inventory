import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec 33 reply-only email-in: Message-ID helpers. The DB client is mocked;
 * insert payloads and lookup results run through the real helpers.
 */

const H = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const insertValues: unknown[] = [];
  const insertTables: unknown[] = [];

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "where", "limit", "orderBy"]) {
      b[m] = self;
    }
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej);
    return b;
  };

  const insertError = { current: null as unknown };
  const select = vi.fn(() => makeSelect());
  const insert = vi.fn((table: unknown) => ({
    values: (v: unknown) => {
      insertTables.push(table);
      insertValues.push(v);
      if (insertError.current) return Promise.reject(insertError.current);
      return Promise.resolve();
    },
  }));
  const getTicket = vi.fn();
  const addTicketComment = vi.fn();
  const maybeNotifyTicketComment = vi.fn();

  return {
    selectQueue,
    insertValues,
    insertTables,
    insertError,
    select,
    insert,
    getTicket,
    addTicketComment,
    maybeNotifyTicketComment,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.select,
    insert: H.insert,
  },
}));
vi.mock("@/db/tickets", () => ({
  getTicket: (...args: unknown[]) => H.getTicket(...args),
  addTicketComment: (...args: unknown[]) => H.addTicketComment(...args),
}));
vi.mock("@/db/ticket-notify", () => ({
  maybeNotifyTicketComment: (...args: unknown[]) =>
    H.maybeNotifyTicketComment(...args),
}));

import {
  findTicketIdByMessageId,
  getTicketByNumber,
  inboundMessageExists,
  processInboundEmail,
  recordTicketEmailMessage,
  type InboundEmail,
} from "./ticket-email";

const TICKET = {
  id: "ticket-1",
  number: 42,
  subject: "Printer offline",
  status: "open",
  assigneeEmail: "Tech@Example.com",
  requesterEmail: "user@example.com",
  comments: [],
};

function inbound(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    emailId: "email-1",
    messageId: "<in@h2tecs.local>",
    from: "Tech <tech@example.com>",
    subject: "Re: [H2Tecs] [#42] — assigned",
    text: "The printer is still down.\n\nOn Wed, Oct 21, 2026 Tech wrote:\n> old",
    html: "<p>ignored when text is present</p>",
    ...over,
  };
}

/** exists miss, In-Reply-To miss, then a ticket-number row. */
function queueSubjectMatch() {
  H.selectQueue.push([], [], [
    {
      id: "ticket-1",
      number: 42,
      assigneeEmail: "tech@example.com",
      requesterEmail: "user@example.com",
      subject: "Printer offline",
      status: "open",
    },
  ]);
}

beforeEach(() => {
  H.selectQueue.length = 0;
  H.insertValues.length = 0;
  H.insertTables.length = 0;
  H.insertError.current = null;
  H.select.mockClear();
  H.insert.mockClear();
  H.getTicket.mockReset();
  H.addTicketComment.mockReset();
  H.maybeNotifyTicketComment.mockReset();
  H.getTicket.mockResolvedValue(TICKET);
  H.addTicketComment.mockResolvedValue("comment-1");
  H.maybeNotifyTicketComment.mockResolvedValue(undefined);
});

describe("recordTicketEmailMessage", () => {
  it("records and finds by messageId", async () => {
    await recordTicketEmailMessage({
      ticketId: "ticket-1",
      direction: "outbound",
      messageId: "<abc@h2tecs.local>",
      inReplyTo: null,
      fromEmail: "agent@example.com",
    });

    expect(H.insertValues).toEqual([
      {
        ticketId: "ticket-1",
        direction: "outbound",
        messageId: "<abc@h2tecs.local>",
        inReplyTo: null,
        fromEmail: "agent@example.com",
      },
    ]);

    H.selectQueue.push([{ ticketId: "ticket-1" }]);
    await expect(
      findTicketIdByMessageId("<abc@h2tecs.local>"),
    ).resolves.toBe("ticket-1");
  });

  it("returns null when the message id is unknown", async () => {
    H.selectQueue.push([]);
    await expect(findTicketIdByMessageId("<missing>")).resolves.toBeNull();
  });
});

describe("inboundMessageExists", () => {
  it("is true after an inbound insert", async () => {
    await recordTicketEmailMessage({
      ticketId: "ticket-1",
      direction: "inbound",
      messageId: "<in@h2tecs.local>",
      inReplyTo: "<abc@h2tecs.local>",
      fromEmail: "user@example.com",
    });

    expect(H.insertValues[0]).toMatchObject({
      direction: "inbound",
      messageId: "<in@h2tecs.local>",
    });

    H.selectQueue.push([{ id: "row-1" }]);
    await expect(inboundMessageExists("<in@h2tecs.local>")).resolves.toBe(
      true,
    );
  });

  it("is false when no inbound row exists", async () => {
    H.selectQueue.push([]);
    await expect(inboundMessageExists("<missing>")).resolves.toBe(false);
  });
});

describe("getTicketByNumber", () => {
  it("returns id, number, emails, subject, and status", async () => {
    H.selectQueue.push([
      {
        id: "ticket-1",
        number: 42,
        assigneeEmail: "tech@example.com",
        requesterEmail: "user@example.com",
        subject: "Printer offline",
        status: "open",
      },
    ]);

    await expect(getTicketByNumber(42)).resolves.toEqual({
      id: "ticket-1",
      number: 42,
      assigneeEmail: "tech@example.com",
      requesterEmail: "user@example.com",
      subject: "Printer offline",
      status: "open",
    });
  });

  it("returns null when the ticket number is unknown", async () => {
    H.selectQueue.push([]);
    await expect(getTicketByNumber(99)).resolves.toBeNull();
  });
});

describe("processInboundEmail", () => {
  it("adds a user comment from an assignee reply matched by [#N]", async () => {
    queueSubjectMatch();

    await expect(processInboundEmail(inbound())).resolves.toEqual({
      status: "commented",
    });

    expect(H.insertValues).toEqual([
      {
        ticketId: "ticket-1",
        direction: "inbound",
        messageId: "<in@h2tecs.local>",
        inReplyTo: null,
        fromEmail: "tech@example.com",
      },
    ]);
    expect(H.addTicketComment).toHaveBeenCalledWith("ticket-1", {
      authorEmail: "tech@example.com",
      body: "The printer is still down.",
      kind: "user",
    });
    expect(H.maybeNotifyTicketComment).toHaveBeenCalledWith({
      ticket: {
        id: "ticket-1",
        number: 42,
        subject: "Printer offline",
        status: "open",
        assigneeEmail: "Tech@Example.com",
        requesterEmail: "user@example.com",
      },
      actorEmail: "tech@example.com",
      body: "The printer is still down.",
      kind: "user",
    });
    expect(H.addTicketComment.mock.invocationCallOrder[0]).toBeGreaterThan(
      H.insert.mock.invocationCallOrder[0],
    );
    expect(
      H.maybeNotifyTicketComment.mock.invocationCallOrder[0],
    ).toBeGreaterThan(H.addTicketComment.mock.invocationCallOrder[0]);
  });

  it("matches In-Reply-To before the subject and accepts the requester", async () => {
    H.selectQueue.push([], [{ ticketId: "ticket-1" }]);

    await expect(
      processInboundEmail(
        inbound({
          from: "Requester <User@Example.com>",
          subject: "Re: printer",
          text: "I rebooted it.",
          headers: { "In-Reply-To": "<out@h2tecs.local>" },
        }),
      ),
    ).resolves.toEqual({ status: "commented" });

    expect(H.getTicket).toHaveBeenCalledWith("ticket-1");
    expect(H.insertValues[0]).toMatchObject({
      inReplyTo: "<out@h2tecs.local>",
      fromEmail: "user@example.com",
    });
    expect(H.addTicketComment).toHaveBeenCalledWith("ticket-1", {
      authorEmail: "user@example.com",
      body: "I rebooted it.",
      kind: "user",
    });
  });

  it("uses a rough html-to-text body when text is blank", async () => {
    queueSubjectMatch();

    await expect(
      processInboundEmail(
        inbound({
          text: "   ",
          html: "<p>Need a new <b>toner</b></p>",
        }),
      ),
    ).resolves.toEqual({ status: "commented" });

    expect(H.addTicketComment).toHaveBeenCalledWith(
      "ticket-1",
      expect.objectContaining({ body: "Need a new toner" }),
    );
  });

  it("ignores a sender who is neither assignee nor requester", async () => {
    queueSubjectMatch();

    await expect(
      processInboundEmail(inbound({ from: "Stranger <other@example.com>" })),
    ).resolves.toEqual({ status: "ignored", reason: "unauthorized" });

    expect(H.insertValues).toEqual([]);
    expect(H.addTicketComment).not.toHaveBeenCalled();
    expect(H.maybeNotifyTicketComment).not.toHaveBeenCalled();
  });

  it("ignores mail that does not match a ticket", async () => {
    H.selectQueue.push([], [], []);

    await expect(
      processInboundEmail(inbound({ subject: "Re: [H2Tecs] [#99] — assigned" })),
    ).resolves.toEqual({ status: "ignored", reason: "no_ticket" });

    expect(H.getTicket).not.toHaveBeenCalled();
    expect(H.addTicketComment).not.toHaveBeenCalled();
  });

  it("ignores a matched number when the ticket row is gone", async () => {
    queueSubjectMatch();
    H.getTicket.mockResolvedValue(null);

    await expect(processInboundEmail(inbound())).resolves.toEqual({
      status: "ignored",
      reason: "no_ticket",
    });
    expect(H.addTicketComment).not.toHaveBeenCalled();
  });

  it("ignores a duplicate inbound message id before writing", async () => {
    H.selectQueue.push([{ id: "row-1" }]);

    await expect(processInboundEmail(inbound())).resolves.toEqual({
      status: "duplicate",
    });

    expect(H.insert).not.toHaveBeenCalled();
    expect(H.addTicketComment).not.toHaveBeenCalled();
    expect(H.maybeNotifyTicketComment).not.toHaveBeenCalled();
  });

  it("treats a unique message-id insert conflict as a duplicate", async () => {
    queueSubjectMatch();
    H.insertError.current = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });

    await expect(processInboundEmail(inbound())).resolves.toEqual({
      status: "duplicate",
    });

    expect(H.addTicketComment).not.toHaveBeenCalled();
    expect(H.maybeNotifyTicketComment).not.toHaveBeenCalled();
  });

  it("ignores a reply whose body is empty after quote stripping", async () => {
    queueSubjectMatch();

    await expect(
      processInboundEmail(
        inbound({
          text: "On Mon, Jan 1, 2026 Someone wrote:\n> previous",
          html: "<p>should not be used when text is non-empty</p>",
        }),
      ),
    ).resolves.toEqual({ status: "ignored", reason: "empty_body" });

    expect(H.insertValues).toEqual([]);
    expect(H.addTicketComment).not.toHaveBeenCalled();
  });

  it("ignores mail with no message id", async () => {
    await expect(
      processInboundEmail(inbound({ messageId: "" })),
    ).resolves.toEqual({ status: "ignored", reason: "no_message_id" });

    expect(H.select).not.toHaveBeenCalled();
    expect(H.addTicketComment).not.toHaveBeenCalled();
  });
});
