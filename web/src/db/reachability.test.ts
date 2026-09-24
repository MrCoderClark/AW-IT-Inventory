import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the printer reachability engine (spec 12). The DB client is the
 * boundary and is mocked; the transition math runs for real. Locks AC-6 (the
 * printer target list), AC-7 (down after 2 fails, one down alert, one recovery,
 * no duplicates, and the retry when a send hasn't happened), and AC-10 (prune).
 */

const H = vi.hoisted(() => {
  const state: {
    selectRows: unknown[];
    prev: Record<string, unknown> | undefined;
    deleteRows: unknown[];
    captured: Record<string, unknown>;
  } = { selectRows: [], prev: undefined, deleteRows: [], captured: {} };

  // db.select(...).from(...).innerJoin(...).where(...) -> selectRows
  const selectMock = vi.fn(() => ({
    from: () => ({
      innerJoin: () => ({ where: () => Promise.resolve(state.selectRows) }),
    }),
  }));

  // Inside db.transaction: tx.insert / tx.select / tx.update
  const tx = {
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => {
        if ("method" in v) state.captured.checkInsert = v;
        else state.captured.statusInsert = v;
        return Promise.resolve();
      },
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.prev ? [state.prev] : []),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (s: Record<string, unknown>) => {
        state.captured.statusUpdate = s;
        return { where: () => Promise.resolve() };
      },
    })),
  };
  const transactionMock = vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));

  // db.delete(...).where(...).returning(...) -> deleteRows
  const deleteMock = vi.fn(() => ({
    where: () => ({ returning: () => Promise.resolve(state.deleteRows) }),
  }));

  // db.update(...).set(...).where(...)  (markAlertSent)
  const updateMock = vi.fn(() => ({
    set: (s: Record<string, unknown>) => {
      state.captured.alertSet = s;
      return { where: () => Promise.resolve() };
    },
  }));

  return { state, selectMock, transactionMock, deleteMock, updateMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    transaction: H.transactionMock,
    delete: H.deleteMock,
    update: H.updateMock,
  },
}));

import {
  recordChecks,
  listPrinterTargets,
  pruneChecks,
  markAlertSent,
  type IncomingCheck,
} from "./reachability";

const AT = "2026-09-22T10:00:00.000Z";
const META = [{ assetId: "a1", name: "Printer A", ip: "10.0.0.5" }];

function status(overrides: Record<string, unknown> = {}) {
  return {
    assetId: "a1",
    reachable: null,
    lastCheckedAt: null,
    lastReachableAt: null,
    consecutiveFailures: 0,
    isDown: false,
    downSince: null,
    lastAlertState: "up",
    updatedAt: new Date(),
    ...overrides,
  };
}
function check(reachable: boolean, extra: Partial<IncomingCheck> = {}): IncomingCheck {
  return { assetId: "a1", reachable, method: "tcp", source: "manual", checkedAt: AT, ...extra };
}

beforeEach(() => {
  H.state.selectRows = META;
  H.state.prev = undefined;
  H.state.deleteRows = [];
  H.state.captured = {};
  vi.clearAllMocks();
});

describe("recordChecks — transitions (AC-7)", () => {
  it("first failure does not mark down and records failures=1", async () => {
    H.state.prev = undefined; // no status row yet
    const events = await recordChecks([check(false)]);
    expect(events).toEqual([]);
    expect(H.state.captured.statusInsert).toMatchObject({
      consecutiveFailures: 1,
      isDown: false,
    });
  });

  it("second consecutive failure marks down and fires one down alert", async () => {
    H.state.prev = status({ consecutiveFailures: 1, lastAlertState: "up" });
    const events = await recordChecks([check(false)]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      assetId: "a1",
      event: "down",
      name: "Printer A",
      ip: "10.0.0.5",
    });
    expect(H.state.captured.statusUpdate).toMatchObject({
      consecutiveFailures: 2,
      isDown: true,
    });
  });

  it("re-fires the down transition while the alert has not been sent (retry)", async () => {
    H.state.prev = status({ consecutiveFailures: 2, isDown: true, lastAlertState: "up" });
    const events = await recordChecks([check(false)]);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("down");
  });

  it("does not repeat the down alert once it has been sent (dedupe)", async () => {
    H.state.prev = status({ consecutiveFailures: 2, isDown: true, lastAlertState: "down" });
    const events = await recordChecks([check(false)]);
    expect(events).toEqual([]);
  });

  it("fires one recovery alert on the first success after a sent down", async () => {
    H.state.prev = status({ consecutiveFailures: 2, isDown: true, lastAlertState: "down" });
    const events = await recordChecks([check(true)]);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("up");
    expect(H.state.captured.statusUpdate).toMatchObject({
      consecutiveFailures: 0,
      isDown: false,
      downSince: null,
    });
  });

  it("does not fire a recovery when no down alert was ever sent", async () => {
    H.state.prev = status({ consecutiveFailures: 2, isDown: true, lastAlertState: "up" });
    const events = await recordChecks([check(true)]);
    expect(events).toEqual([]);
  });

  it("skips a check for an unknown (non-printer) asset", async () => {
    H.state.selectRows = []; // meta lookup finds nothing
    const events = await recordChecks([check(false)]);
    expect(events).toEqual([]);
    expect(H.transactionMock).not.toHaveBeenCalled();
  });

  it("skips a check with an invalid timestamp", async () => {
    const events = await recordChecks([check(false, { checkedAt: "not-a-date" })]);
    expect(events).toEqual([]);
  });

  it("returns nothing for an empty batch", async () => {
    expect(await recordChecks([])).toEqual([]);
  });
});

describe("listPrinterTargets (AC-6)", () => {
  it("returns printers with an IP and drops blank ones", async () => {
    H.state.selectRows = [
      { assetId: "a1", ipAddress: "10.0.0.5" },
      { assetId: "a2", ipAddress: "   " },
      { assetId: "a3", ipAddress: "" },
      { assetId: "a4", ipAddress: "10.0.0.9" },
    ];
    const targets = await listPrinterTargets();
    expect(targets).toEqual([
      { assetId: "a1", ipAddress: "10.0.0.5" },
      { assetId: "a4", ipAddress: "10.0.0.9" },
    ]);
  });
});

describe("pruneChecks (AC-10)", () => {
  it("returns the number of rows deleted", async () => {
    H.state.deleteRows = [{ id: "1" }, { id: "2" }, { id: "3" }];
    expect(await pruneChecks(365)).toBe(3);
  });

  it("still runs with a non-positive retention (defaults safely)", async () => {
    H.state.deleteRows = [{ id: "1" }];
    expect(await pruneChecks(0)).toBe(1);
    expect(H.deleteMock).toHaveBeenCalled();
  });
});

describe("markAlertSent", () => {
  it("writes the new alert state", async () => {
    await markAlertSent("a1", "down");
    expect(H.state.captured.alertSet).toMatchObject({ lastAlertState: "down" });
  });
});
