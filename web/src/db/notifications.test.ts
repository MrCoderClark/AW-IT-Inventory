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
  notifyDeployResult,
  notifyInstallResult,
  notifyPatchInstallResult,
  notifyScriptRunResult,
  pruneNotifications,
  sweepWarrantyNotifications,
} from "./notifications";

/** Flatten a drizzle `sql` template (including nested fragments) to its source text. */
function sqlSource(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!chunks) return "";
  return chunks
    .map((chunk) => {
      if (
        chunk &&
        typeof chunk === "object" &&
        Array.isArray((chunk as { value?: unknown }).value)
      ) {
        return ((chunk as { value: string[] }).value).join("");
      }
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
        return sqlSource(chunk);
      }
      return "";
    })
    .join("");
}

/** Bound parameters of a drizzle `sql` template (nested fragments included). */
function sqlParams(query: unknown, out: unknown[] = []): unknown[] {
  if (!query || typeof query !== "object") return out;
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!chunks) return out;
  for (const chunk of chunks) {
    if (typeof chunk === "string" || typeof chunk === "number" || typeof chunk === "boolean") {
      out.push(chunk);
    } else if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      sqlParams(chunk, out);
    }
  }
  return out;
}

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
      requestedBy: "tech@opus.local",
    });
    const v = H.insertValues.at(-1) as Record<string, unknown>;
    expect(v).toMatchObject({
      type: "printer-install",
      severity: "info",
      title: "Printer installed",
      href: "/assets/PC-1",
      dedupeKey: "printer-install:j1:succeeded",
      assetId: "a1",
      audience: "user",
      recipientEmail: "tech@opus.local",
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
      requestedBy: "tech@opus.local",
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
      requestedBy: "tech@opus.local",
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
      requestedBy: "tech@opus.local",
    });
    expect(H.db.select).not.toHaveBeenCalled();
    expect(H.insertValues).toHaveLength(0);
  });

  it("schedule requestedBy keeps admin audience", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push(createdRow("printer-install"));
    await notifyInstallResult({
      jobId: "j5",
      action: "install",
      status: "succeeded",
      assetId: "a1",
      printerName: "Canon iR",
      error: null,
      requestedBy: "schedule:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    const v = H.insertValues.at(-1) as Record<string, unknown>;
    expect(v).toMatchObject({
      audience: "admins",
      recipientEmail: null,
    });
  });
});

describe("notifyScriptRunResult audience", () => {
  const asset = [{ tag: "PC-1", name: "Reception PC" }];
  it("email → user", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push([
      {
        id: "n1",
        type: "script-run",
        severity: "info",
        title: "t",
        body: "b",
        href: "/assets/PC-1",
        assetId: "a1",
        createdAt: new Date("2026-10-06T12:00:00Z"),
      },
    ]);
    await notifyScriptRunResult({
      jobId: "s1",
      status: "succeeded",
      assetId: "a1",
      scriptName: "DiskCleanup",
      error: null,
      requestedBy: "tech@opus.local",
    });
    expect(H.insertValues.at(-1)).toMatchObject({
      audience: "user",
      recipientEmail: "tech@opus.local",
    });
  });
  it("schedule → admins", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push([
      {
        id: "n2",
        type: "script-run",
        severity: "info",
        title: "t",
        body: "b",
        href: "/assets/PC-1",
        assetId: "a1",
        createdAt: new Date("2026-10-06T12:00:00Z"),
      },
    ]);
    await notifyScriptRunResult({
      jobId: "s2",
      status: "succeeded",
      assetId: "a1",
      scriptName: "DiskCleanup",
      error: null,
      requestedBy: "schedule:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    expect(H.insertValues.at(-1)).toMatchObject({
      audience: "admins",
      recipientEmail: null,
    });
  });
});

describe("notifyDeployResult audience", () => {
  const asset = [{ tag: "PC-1", name: "Reception PC" }];
  it("email → user", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push([
      {
        id: "n1",
        type: "software-deploy",
        severity: "info",
        title: "t",
        body: "b",
        href: "/assets/PC-1",
        assetId: "a1",
        createdAt: new Date("2026-10-06T12:00:00Z"),
      },
    ]);
    await notifyDeployResult({
      deploymentId: "d1",
      status: "succeeded",
      assetId: "a1",
      packageName: "7-Zip",
      packageVersion: "24.0",
      error: null,
      requestedBy: "tech@opus.local",
    });
    expect(H.insertValues.at(-1)).toMatchObject({
      audience: "user",
      recipientEmail: "tech@opus.local",
    });
  });
  it("schedule → admins", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push([
      {
        id: "n2",
        type: "software-deploy",
        severity: "info",
        title: "t",
        body: "b",
        href: "/assets/PC-1",
        assetId: "a1",
        createdAt: new Date("2026-10-06T12:00:00Z"),
      },
    ]);
    await notifyDeployResult({
      deploymentId: "d2",
      status: "succeeded",
      assetId: "a1",
      packageName: "7-Zip",
      packageVersion: "24.0",
      error: null,
      requestedBy: "schedule:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    expect(H.insertValues.at(-1)).toMatchObject({
      audience: "admins",
      recipientEmail: null,
    });
  });
});

describe("notifyPatchInstallResult audience", () => {
  const asset = [{ tag: "PC-1", name: "Reception PC" }];
  it("email → user", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push([
      {
        id: "n1",
        type: "patch-install",
        severity: "info",
        title: "t",
        body: "b",
        href: "/assets/PC-1",
        assetId: "a1",
        createdAt: new Date("2026-10-06T12:00:00Z"),
      },
    ]);
    await notifyPatchInstallResult({
      jobId: "p1",
      status: "succeeded",
      assetId: "a1",
      osCount: 1,
      appCount: 0,
      error: null,
      requestedBy: "tech@opus.local",
    });
    expect(H.insertValues.at(-1)).toMatchObject({
      audience: "user",
      recipientEmail: "tech@opus.local",
    });
  });
  it("schedule → admins", async () => {
    H.selectQueue.push(asset);
    H.insertReturning.push([
      {
        id: "n2",
        type: "patch-install",
        severity: "info",
        title: "t",
        body: "b",
        href: "/assets/PC-1",
        assetId: "a1",
        createdAt: new Date("2026-10-06T12:00:00Z"),
      },
    ]);
    await notifyPatchInstallResult({
      jobId: "p2",
      status: "succeeded",
      assetId: "a1",
      osCount: 1,
      appCount: 0,
      error: null,
      requestedBy: "schedule:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    expect(H.insertValues.at(-1)).toMatchObject({
      audience: "admins",
      recipientEmail: null,
    });
  });
});

describe("unread + mark read", () => {
  const viewer = { userKey: "u1", email: "u1@x.com", isAdmin: true };

  it("getUnreadCount returns the counted rows", async () => {
    H.selectQueue.push([{ count: 3 }]);
    expect(await getUnreadCount(viewer)).toBe(3);
  });

  it("markRead inserts a read row then returns the new count when visible", async () => {
    H.selectQueue.push([{ id: "n1" }]); // visibility check
    H.selectQueue.push([{ count: 2 }]); // getUnreadCount after the insert
    const n = await markRead(viewer, "n1");
    expect(H.db.insert).toHaveBeenCalled();
    expect(n).toBe(2);
  });

  it("markRead skips the insert when the notification is not visible", async () => {
    H.selectQueue.push([]); // visibility check → empty
    H.selectQueue.push([{ count: 3 }]); // getUnreadCount only
    const n = await markRead(
      { userKey: "u2", email: "tech@x.com", isAdmin: false },
      "admin-only-n",
    );
    expect(H.db.insert).not.toHaveBeenCalled();
    expect(n).toBe(3);
  });

  it("markAllRead runs the insert-select then returns 0", async () => {
    H.selectQueue.push([{ count: 0 }]);
    const n = await markAllRead(viewer);
    expect(H.executeMock).toHaveBeenCalledTimes(1);
    expect(n).toBe(0);
  });

  it("markAllRead for an admin only covers broadcasts and that admin's user rows", async () => {
    H.selectQueue.push([{ count: 0 }]);
    await markAllRead(viewer);
    const text = sqlSource(H.executeMock.mock.calls[0][0]).toLowerCase();
    expect(text).toContain("n.audience = 'admins'");
    expect(text).toContain("n.audience = 'user'");
    expect(text).toContain("lower(n.recipient_email)");
    expect(sqlParams(H.executeMock.mock.calls[0][0])).toContain("u1@x.com");
  });

  it("markAllRead for a non-admin never selects audience=admins rows", async () => {
    H.selectQueue.push([{ count: 0 }]);
    await markAllRead({ userKey: "u2", email: "Tech@x.com", isAdmin: false });
    const query = H.executeMock.mock.calls[0][0];
    const text = sqlSource(query).toLowerCase();
    expect(text).toContain("n.audience = 'user'");
    expect(text).toContain("lower(n.recipient_email)");
    expect(text).not.toContain("admins");
    expect(sqlParams(query)).toContain("Tech@x.com");
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
