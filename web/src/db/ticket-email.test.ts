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

  const select = vi.fn(() => makeSelect());
  const insert = vi.fn((table: unknown) => ({
    values: (v: unknown) => {
      insertTables.push(table);
      insertValues.push(v);
      return Promise.resolve();
    },
  }));

  return { selectQueue, insertValues, insertTables, select, insert };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.select,
    insert: H.insert,
  },
}));

import {
  findTicketIdByMessageId,
  getTicketByNumber,
  inboundMessageExists,
  recordTicketEmailMessage,
} from "./ticket-email";

beforeEach(() => {
  H.selectQueue.length = 0;
  H.insertValues.length = 0;
  H.insertTables.length = 0;
  H.select.mockClear();
  H.insert.mockClear();
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
