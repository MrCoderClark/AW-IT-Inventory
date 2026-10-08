import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the notification data layer (spec 19). The DB client and the
 * SSE bus are the boundary and are mocked; the idempotency, unread math, and the
 * warranty bucketing run for real against a frozen "today".
 */

const H = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const insertReturning: unknown[][] = [];
  const deleteReturning: unknown[][] = [];
  const publishMock = vi.fn();
  const executeMock = vi.fn(async () => undefined);

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit", "groupBy"]) {
      b[m] = () => b;
    }
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej);
    return b;
  };

  const insertValues: unknown[] = [];
  const insertMock = vi.fn(() => ({
    values: (v: unknown) => {
      insertValues.push(v); // capture the payload so tests can assert on it
      // Awaitable (markRead awaits onConflictDoNothing directly) AND chainable
      // with .returning() (createNotification uses it).
      const oc = () => {
        const q = Promise.resolve(undefined) as Promise<unknown> & {
          returning?: () => Promise<unknown>;
        };
        q.returning = () => Promise.resolve(insertReturning.shift() ?? []);
        return q;
      };
      return { onConflictDoNothing: oc };
    },
  }));

  const deleteMock = vi.fn(() => ({
    where: () => ({ returning: () => Promise.resolve(deleteReturning.shift() ?? []) }),
  }));

  return {
    selectQueue,
    insertReturning,
    insertValues,
    deleteReturning,
    publishMock,
    executeMock,
    db: {
      select: vi.fn(() => makeSelect()),
      insert: insertMock,
      delete: deleteMock,
      execute: executeMock,
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({ db: H.db }));
vi.mock("@/lib/notification-bus", () => ({ publishNotification: H.publishMock }));

import {
  createNotification,
  getUnreadCount,
  markAllRead,
  markRead,
  notifyInstallResult,
  pruneNotifications,
  sweepWarrantyNotifications,
} from "./notifications";

beforeEach(() => {
  H.selectQueue.length = 0;
  H.insertReturning.length = 0;
  H.insertValues.length = 0;
  H.deleteReturning.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createNotification", () => {
  it("inserts, publishes to the bus, and returns the id", async () => {
    H.insertReturning.push([
      {
        id: "n1",
        type: "scan-failed",
        severity: "warning",
        title: "t",
        body: "b",
        href: "/scans/jobs",
        assetId: null,
        createdAt: new Date("2026-10-06T12:00:00Z"),
      },
    ]);
    const id = await createNotification({
      type: "scan-failed",
      severity: "warning",
      title: "t",
      body: "b",
      href: "/scans/jobs",
      dedupeKey: "scan-failed:job-1",
    });
    expect(id).toBe("n1");
    expect(H.publishMock).toHaveBeenCalledTimes(1);
    expect(H.publishMock.mock.calls[0][0]).toMatchObject({ id: "n1", type: "scan-failed" });
  });

  it("is a no-op on a dedupe conflict: returns null and does not publish", async () => {
    H.insertReturning.push([]); // onConflictDoNothing → no row
    const id = await createNotification({
      type: "scan-failed",
      severity: "warning",
      title: "t",
      body: "b",
      href: "/scans/jobs",
      dedupeKey: "scan-failed:job-1",
    });
    expect(id).toBeNull();
    expect(H.publishMock).not.toHaveBeenCalled();
  });
});

describe("notifyInstallResult", () => {
  const asset = [{ tag: "PC-1", name: "Reception PC" }];
  const createdRow = (type: string) => [
    {
      id: "n9",
      type,
      severity: "info",
      title: "t",
      body: "b",
      href: "/assets/PC-1",
      assetId: "a1",
      createdAt: new Date("2026-10-06T12:00:00Z"),
    },
  ];

  it("install succeeded → info printer-install deep-linked to the asset", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push(createdRow("printer-install"));
    await notifyInstallResult({
      jobId: "j1",
      action: "install",
      status: "succeeded",
      assetId: "a1",
      printerName: "Canon iR",
      error: null,
    });
    const v = H.insertValues.at(-1) as Record<string, unknown>;
    expect(v).toMatchObject({
      type: "printer-install",
      severity: "info",
      title: "Printer installed",
      href: "/assets/PC-1",
      dedupeKey: "printer-install:j1:succeeded",
      assetId: "a1",
    });
    expect(v.body).toBe('"Canon iR" was installed on Reception PC.');
  });

  it("install failed → warning printer-install-failed carrying the trimmed error", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push(createdRow("printer-install-failed"));
    await notifyInstallResult({
      jobId: "j2",
      action: "install",
      status: "failed",
      assetId: "a1",
      printerName: "Canon iR",
      error: "  publisher not trusted  ",
    });
    const v = H.insertValues.at(-1) as Record<string, unknown>;
    expect(v).toMatchObject({
      type: "printer-install-failed",
      severity: "warning",
      title: "Printer install failed",
      dedupeKey: "printer-install:j2:failed",
    });
    expect(v.body).toBe('Installing "Canon iR" on Reception PC failed: publisher not trusted');
  });

  it("remove succeeded → 'removed from' wording", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push(createdRow("printer-install"));
    await notifyInstallResult({
      jobId: "j3",
      action: "remove",
      status: "succeeded",
      assetId: "a1",
      printerName: "Old HP",
      error: null,
    });
    const v = H.insertValues.at(-1) as Record<string, unknown>;
    expect(v.title).toBe("Printer removed");
    expect(v.body).toBe('"Old HP" was removed from Reception PC.');
  });

  it("list ops are silent: no asset lookup and no notification", async () => {
    await notifyInstallResult({
      jobId: "j4",
      action: "list",
      status: "succeeded",
      assetId: "a1",
      printerName: null,
    });
    expect(H.db.select).not.toHaveBeenCalled();
    expect(H.insertValues).toHaveLength(0);
  });
});

describe("unread + mark read", () => {
  it("getUnreadCount returns the counted rows", async () => {
    H.selectQueue.push([{ count: 3 }]);
    expect(await getUnreadCount("u1")).toBe(3);
  });

  it("markRead inserts a read row then returns the new count", async () => {
    H.selectQueue.push([{ count: 2 }]); // getUnreadCount after the insert
    const n = await markRead("u1", "n1");
    expect(H.db.insert).toHaveBeenCalled();
    expect(n).toBe(2);
  });

  it("markAllRead runs the insert-select then returns 0", async () => {
    H.selectQueue.push([{ count: 0 }]);
    const n = await markAllRead("u1");
    expect(H.executeMock).toHaveBeenCalledTimes(1);
    expect(n).toBe(0);
  });
});

describe("sweepWarrantyNotifications", () => {
  it("creates one per expired/≤threshold asset and skips the rest", async () => {
    H.selectQueue.push([
      { id: "a1", tag: "T-1", name: "Expired", warrantyUntil: "2026-01-01" }, // expired
      { id: "a2", tag: "T-2", name: "Soon", warrantyUntil: "2026-10-20" }, // in 14 days ≤30
      { id: "a3", tag: "T-3", name: "Later", warrantyUntil: "2027-10-06" }, // >30 → skip
    ]);
    // Two creations succeed (return a row each).
    H.insertReturning.push([{ id: "n-a1", type: "warranty-expiring", severity: "critical", title: "", body: "", href: "", assetId: "a1", createdAt: new Date() }]);
    H.insertReturning.push([{ id: "n-a2", type: "warranty-expiring", severity: "warning", title: "", body: "", href: "", assetId: "a2", createdAt: new Date() }]);

    const created = await sweepWarrantyNotifications();
    expect(created).toBe(2);
    // Only the two qualifying assets were inserted.
    expect(H.db.insert).toHaveBeenCalledTimes(2);
  });
});

describe("pruneNotifications", () => {
  it("returns the number of deleted rows", async () => {
    H.deleteReturning.push([{ id: "n1" }, { id: "n2" }]);
    expect(await pruneNotifications(90)).toBe(2);
  });
});
