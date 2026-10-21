import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec 33 tickets data layer. DB is mocked (hoisted select queue + transaction tx);
 * number allocation, notification dedupe, and auto-create gating run for real.
 */

const H = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const insertReturning: unknown[][] = [];
  const insertValues: unknown[] = [];
  const insertError: (Error & { code?: string }) | null = null;

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of [
      "from",
      "leftJoin",
      "innerJoin",
      "where",
      "orderBy",
      "limit",
      "groupBy",
    ]) {
      b[m] = self;
    }
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej);
    return b;
  };

  const select = vi.fn(() => makeSelect());

  const makeInsertChain = () => ({
    values: (v: unknown) => {
      insertValues.push(v);
      if (insertError) return Promise.reject(insertError);
      const ret = Promise.resolve(undefined) as Promise<unknown> & {
        returning?: () => Promise<unknown>;
        onConflictDoUpdate?: () => Promise<unknown>;
      };
      ret.returning = () => Promise.resolve(insertReturning.shift() ?? []);
      ret.onConflictDoUpdate = () => Promise.resolve(undefined);
      return ret;
    },
  });

  const insert = vi.fn(() => makeInsertChain());
  const tx = { select, insert };

  const transaction = vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));

  const draftTicketFieldsFromNotification = vi.fn();

  return {
    selectQueue,
    insertReturning,
    insertValues,
    select,
    insert,
    transaction,
    draftTicketFieldsFromNotification,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.select,
    insert: H.insert,
    transaction: H.transaction,
  },
}));
vi.mock("./ai-ticket-draft", () => ({
  draftTicketFieldsFromNotification: H.draftTicketFieldsFromNotification,
}));

import {
  createTicket,
  createTicketFromNotification,
  getTicketIdsByNotificationIds,
  maybeAutoCreateTicketFromNotification,
} from "./tickets";

beforeEach(() => {
  H.selectQueue.length = 0;
  H.insertReturning.length = 0;
  H.insertValues.length = 0;
  H.select.mockClear();
  H.insert.mockClear();
  H.transaction.mockClear();
  H.draftTicketFieldsFromNotification.mockReset();
});

describe("createTicket", () => {
  it("allocates the next ticket number and adds a system comment", async () => {
    H.selectQueue.push([{ m: 4 }]);
    H.insertReturning.push([{ id: "ticket-1", number: 5 }]);

    const result = await createTicket({
      subject: "Printer offline",
      createdBy: "admin@example.com",
    });

    expect(result).toEqual({ id: "ticket-1", number: 5 });
    expect(H.transaction).toHaveBeenCalledTimes(1);
    expect(H.insertValues).toHaveLength(2);
    expect(H.insertValues[1]).toMatchObject({
      ticketId: "ticket-1",
      body: "Ticket created",
      kind: "system",
    });
  });
});

describe("getTicketIdsByNotificationIds", () => {
  it("returns an empty map for no ids", async () => {
    await expect(getTicketIdsByNotificationIds([])).resolves.toEqual({});
    expect(H.select).not.toHaveBeenCalled();
  });

  it("maps source notification ids to ticket ids", async () => {
    H.selectQueue.push([
      { id: "ticket-1", sourceNotificationId: "notif-a" },
      { id: "ticket-2", sourceNotificationId: "notif-b" },
    ]);

    await expect(
      getTicketIdsByNotificationIds(["notif-a", "notif-b", "notif-c"]),
    ).resolves.toEqual({
      "notif-a": "ticket-1",
      "notif-b": "ticket-2",
    });
  });
});

describe("createTicketFromNotification", () => {
  const notif = {
    id: "notif-1",
    type: "printer-down",
    title: "Printer down",
    body: "HP LaserJet unreachable",
    assetId: "asset-1",
  };

  it("returns existingId on a second create for the same notification", async () => {
    H.selectQueue.push([notif]);
    H.selectQueue.push([]);
    H.selectQueue.push([{ m: null }]);
    H.insertReturning.push([{ id: "ticket-a", number: 1 }]);

    const first = await createTicketFromNotification("notif-1", "admin@example.com");
    expect(first).toEqual({ id: "ticket-a", number: 1 });

    H.selectQueue.push([notif]);
    H.selectQueue.push([{ id: "ticket-a" }]);

    const second = await createTicketFromNotification("notif-1", "admin@example.com");
    expect(second).toEqual({ existingId: "ticket-a" });
    expect(H.insertValues).toHaveLength(2);
  });

  function primeCreate() {
    H.selectQueue.push([notif]);
    H.selectQueue.push([]);
    H.selectQueue.push([{ m: 6 }]);
    H.insertReturning.push([{ id: "ticket-ai", number: 7 }]);
  }

  it("does not call AI draft when useAi is omitted (auto-create path)", async () => {
    primeCreate();

    const result = await createTicketFromNotification("notif-1", "admin@example.com");

    expect(result).toEqual({ id: "ticket-ai", number: 7 });
    expect(H.draftTicketFieldsFromNotification).not.toHaveBeenCalled();
    expect(H.insertValues[0]).toMatchObject({
      subject: notif.title,
      description: notif.body,
      category: "Alert",
      priority: "medium",
    });
  });

  it("applies AI draft when useAi true and draft returns fields", async () => {
    primeCreate();
    H.draftTicketFieldsFromNotification.mockResolvedValue({
      subject: "Replace the down printer",
      description: "LaserJet on floor 2 is unreachable after two probes.",
      category: "Printer",
      priority: "high",
    });

    const result = await createTicketFromNotification("notif-1", "admin@example.com", {
      useAi: true,
    });

    expect(result).toEqual({ id: "ticket-ai", number: 7 });
    expect(H.draftTicketFieldsFromNotification).toHaveBeenCalledWith(
      "notif-1",
      "admin@example.com",
    );
    expect(H.insertValues[0]).toMatchObject({
      subject: "Replace the down printer",
      description: "LaserJet on floor 2 is unreachable after two probes.",
      category: "Printer",
      priority: "high",
      sourceNotificationId: "notif-1",
      createdBy: "admin@example.com",
    });
  });

  it("falls back to notification title/body when draft returns null", async () => {
    primeCreate();
    H.draftTicketFieldsFromNotification.mockResolvedValue(null);

    const result = await createTicketFromNotification("notif-1", "admin@example.com", {
      useAi: true,
    });

    expect(result).toEqual({ id: "ticket-ai", number: 7 });
    expect(H.draftTicketFieldsFromNotification).toHaveBeenCalledOnce();
    expect(H.insertValues[0]).toMatchObject({
      subject: notif.title,
      description: notif.body,
      category: "Alert",
      priority: "medium",
    });
  });

  it("falls back to notification title/body when the draft throws", async () => {
    primeCreate();
    H.draftTicketFieldsFromNotification.mockRejectedValue(new Error("provider down"));

    const result = await createTicketFromNotification("notif-1", "admin@example.com", {
      useAi: true,
    });

    expect(result).toEqual({ id: "ticket-ai", number: 7 });
    expect(H.draftTicketFieldsFromNotification).toHaveBeenCalledOnce();
    expect(H.insertValues[0]).toMatchObject({
      subject: notif.title,
      description: notif.body,
      category: "Alert",
      priority: "medium",
    });
  });
});

describe("maybeAutoCreateTicketFromNotification", () => {
  const row = {
    id: "notif-2",
    type: "metric-threshold" as const,
    title: "Disk full",
    body: "C: at 95%",
    assetId: null,
  };

  it("no-ops when the notification type is not enabled for auto-create", async () => {
    H.selectQueue.push([]);

    await maybeAutoCreateTicketFromNotification(row);

    expect(H.transaction).not.toHaveBeenCalled();
    expect(H.insertValues).toHaveLength(0);
  });

  it("creates a ticket when the type is enabled", async () => {
    H.selectQueue.push([{ enabled: true }]);
    H.selectQueue.push([
      {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        assetId: row.assetId,
      },
    ]);
    H.selectQueue.push([]);
    H.selectQueue.push([{ m: 0 }]);
    H.insertReturning.push([{ id: "auto-ticket", number: 1 }]);

    await maybeAutoCreateTicketFromNotification(row);

    expect(H.transaction).toHaveBeenCalledTimes(1);
    expect(H.draftTicketFieldsFromNotification).not.toHaveBeenCalled();
    expect(H.insertValues[0]).toMatchObject({
      subject: row.title,
      description: row.body,
      sourceNotificationId: row.id,
      createdBy: "system:auto",
      category: "Alert",
    });
  });

  it("force on creates even when global type is disabled", async () => {
    const withMeta = {
      ...row,
      meta: { alertRuleId: "a3000000-0000-4000-8000-000000000001" },
    };
    H.selectQueue.push([{ ticketAutoCreate: "on" }]);
    H.selectQueue.push([
      {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        assetId: row.assetId,
      },
    ]);
    H.selectQueue.push([]);
    H.selectQueue.push([{ m: 0 }]);
    H.insertReturning.push([{ id: "auto-ticket", number: 1 }]);

    await maybeAutoCreateTicketFromNotification(withMeta);

    expect(H.transaction).toHaveBeenCalledTimes(1);
  });

  it("force off skips even when global type is enabled", async () => {
    H.selectQueue.push([{ ticketAutoCreate: "off" }]);
    await maybeAutoCreateTicketFromNotification({
      ...row,
      meta: { alertRuleId: "a3000000-0000-4000-8000-000000000001" },
    });
    expect(H.transaction).not.toHaveBeenCalled();
  });

  it("inherit uses global type toggle", async () => {
    H.selectQueue.push([{ ticketAutoCreate: "inherit" }]);
    H.selectQueue.push([{ enabled: true }]);
    H.selectQueue.push([
      {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        assetId: row.assetId,
      },
    ]);
    H.selectQueue.push([]);
    H.selectQueue.push([{ m: 0 }]);
    H.insertReturning.push([{ id: "auto-ticket", number: 2 }]);

    await maybeAutoCreateTicketFromNotification({
      ...row,
      meta: { alertRuleId: "a3000000-0000-4000-8000-000000000001" },
    });
    expect(H.transaction).toHaveBeenCalledTimes(1);
  });
});
