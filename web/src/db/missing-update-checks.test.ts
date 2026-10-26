import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => {
  const state: {
    selects: unknown[][];
    insertReturns: unknown[][];
    updateReturns: unknown[][];
    execResult: unknown[];
  } = {
    selects: [],
    insertReturns: [],
    updateReturns: [],
    execResult: [],
  };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"])
      b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selects.shift() ?? []).then(res, rej);
    return b;
  };

  return {
    state,
    selectMock: vi.fn(() => makeSelect()),
    insertMock: vi.fn(() => ({
      values: () => ({
        returning: () => Promise.resolve(state.insertReturns.shift() ?? []),
      }),
    })),
    updateMock: vi.fn(() => ({
      set: () => ({
        where: () => {
          const p = Promise.resolve() as Promise<unknown> & {
            returning?: () => Promise<unknown>;
          };
          p.returning = () => Promise.resolve(state.updateReturns.shift() ?? []);
          return p;
        },
      }),
    })),
    executeMock: vi.fn(() => Promise.resolve(state.execResult)),
  };
});

const upsertAuditMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, id: "audit-1" })),
);
const updateAuditMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("server-only", () => ({}));
vi.mock("@/db/computer-audit", () => ({
  upsertAuditEvent: (...args: unknown[]) => upsertAuditMock(...args),
  updateAuditEventStatus: (...args: unknown[]) => updateAuditMock(...args),
}));
vi.mock("@/db/scan", () => ({ isWorkerLive: vi.fn().mockResolvedValue(true) }));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
    execute: H.executeMock,
  },
}));

import {
  enqueueMissingUpdateCheck,
  claimNextMissingUpdateCheck,
  updateMissingUpdateCheckStatus,
  cancelMissingUpdateCheck,
} from "./missing-update-checks";

const JID = "0959927f-1046-4582-9a70-60a4175f206b";

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.updateReturns = [];
  H.state.execResult = [];
});

describe("enqueueMissingUpdateCheck (AC-21)", () => {
  it("refuses when a check is already in flight", async () => {
    H.state.selects = [[{ id: "x" }]];
    expect(
      await enqueueMissingUpdateCheck({
        assetId: "a1",
        targetIp: "1.2.3.4",
        requestedBy: "me",
      }),
    ).toEqual({ ok: false, reason: "already-inflight" });
    expect(upsertAuditMock).not.toHaveBeenCalled();
  });

  it("enqueues when free", async () => {
    H.state.selects = [[]];
    H.state.insertReturns = [[{ id: JID }]];
    expect(
      await enqueueMissingUpdateCheck({
        assetId: "a1",
        targetIp: "1.2.3.4",
        requestedBy: "me",
      }),
    ).toEqual({ ok: true, id: JID });
    expect(upsertAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTable: "missing_update_checks",
        sourceId: JID,
        assetId: "a1",
        action: "missing_update_check",
        operator: "me",
        source: "admin_console",
        summary: "Checked for updates",
        status: "pending",
      }),
    );
  });

  it("records a post-install follow-up as collector", async () => {
    H.state.selects = [[]];
    H.state.insertReturns = [[{ id: JID }]];
    await enqueueMissingUpdateCheck({
      assetId: "a1",
      targetIp: "1.2.3.4",
      requestedBy: "patch-install:ada@x",
    });
    expect(upsertAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operator: "ada@x",
        source: "collector",
        action: "missing_update_check",
      }),
    );
  });
});

describe("claimNextMissingUpdateCheck", () => {
  it("returns a claimed job", async () => {
    H.state.execResult = [{ id: JID }];
    H.state.selects = [
      [
        {
          id: JID,
          assetId: "a1",
          assetTag: "PC1",
          targetIp: "10.0.0.1",
          claimedAt: new Date("2026-10-19T12:00:00.000Z"),
        },
      ],
    ];
    expect(await claimNextMissingUpdateCheck("w1")).toEqual({
      id: JID,
      assetId: "a1",
      assetTag: "PC1",
      targetIp: "10.0.0.1",
      workerId: "w1",
      claimedAt: "2026-10-19T12:00:00.000Z",
    });
  });
});

describe("missing-update check terminal audit", () => {
  const fence = { workerId: "w1", claimedAt: "2026-10-19T12:00:00.000Z" };

  it("updates status on success and skips running", async () => {
    H.state.updateReturns = [[{ id: JID }]];
    expect(
      await updateMissingUpdateCheckStatus(JID, { ...fence, status: "succeeded" }),
    ).toBe("ok");
    expect(updateAuditMock).toHaveBeenCalledWith({
      sourceTable: "missing_update_checks",
      sourceId: JID,
      status: "succeeded",
    });

    updateAuditMock.mockClear();
    H.state.updateReturns = [[{ id: JID }]];
    expect(
      await updateMissingUpdateCheckStatus(JID, { ...fence, status: "running" }),
    ).toBe("ok");
    expect(updateAuditMock).not.toHaveBeenCalled();
  });

  it("cancels the audit row when the job is canceled", async () => {
    H.state.updateReturns = [[{ id: JID }]];
    expect(await cancelMissingUpdateCheck(JID)).toBe(true);
    expect(updateAuditMock).toHaveBeenCalledWith({
      sourceTable: "missing_update_checks",
      sourceId: JID,
      status: "canceled",
    });
  });

  it("does not write audit for a stale status update", async () => {
    H.state.updateReturns = [[]];
    H.state.selects = [[{ id: JID }]];
    expect(
      await updateMissingUpdateCheckStatus(JID, { ...fence, status: "failed" }),
    ).toBe("stale");
    expect(updateAuditMock).not.toHaveBeenCalled();
  });
});
