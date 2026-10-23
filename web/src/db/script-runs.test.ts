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
    notifyMock: vi.fn(),
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
vi.mock("@/db/notifications", () => ({
  notifyScriptRunResult: H.notifyMock,
}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
    execute: H.executeMock,
  },
}));

import {
  enqueueScriptRun,
  claimNextScriptRun,
  updateScriptRunStatus,
  cancelScriptRun,
} from "./script-runs";

const JID = "0959927f-1046-4582-9a70-60a4175f206b";
const SNAP = { name: "Clear spooler", body: "1", timeoutSeconds: 120 };

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.updateReturns = [];
  H.state.execResult = [];
});

describe("enqueueScriptRun", () => {
  it("refuses when in flight", async () => {
    H.state.selects = [[{ id: "x" }]];
    expect(
      await enqueueScriptRun({
        assetId: "a1",
        targetIp: "1.2.3.4",
        scriptId: "s1",
        scriptSnapshot: SNAP,
        requestedBy: "me",
      }),
    ).toEqual({ ok: false, reason: "already-inflight" });
    expect(upsertAuditMock).not.toHaveBeenCalled();
  });

  it("enqueues when free", async () => {
    H.state.selects = [[]];
    H.state.insertReturns = [[{ id: JID }]];
    expect(
      await enqueueScriptRun({
        assetId: "a1",
        targetIp: "1.2.3.4",
        scriptId: "s1",
        scriptSnapshot: SNAP,
        requestedBy: "me",
      }),
    ).toEqual({ ok: true, id: JID });
    expect(upsertAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTable: "script_run_jobs",
        sourceId: JID,
        assetId: "a1",
        action: "script_run",
        operator: "me",
        source: "admin_console",
        summary: "Run Clear spooler",
        status: "pending",
        details: expect.objectContaining({ scriptName: "Clear spooler" }),
      }),
    );
  });

  it("marks a scheduled batch run as scheduled", async () => {
    H.state.selects = [[]];
    H.state.insertReturns = [[{ id: JID }]];
    await enqueueScriptRun({
      assetId: "a1",
      targetIp: "1.2.3.4",
      scriptId: "s1",
      scriptSnapshot: SNAP,
      requestedBy: "schedule:sched-1",
      scheduled: true,
    });
    expect(upsertAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operator: "schedule:sched-1",
        source: "scheduled",
        action: "script_run",
      }),
    );
  });
});

describe("claimNextScriptRun", () => {
  it("returns frozen snapshot", async () => {
    H.state.execResult = [{ id: JID }];
    H.state.selects = [
      [
        {
          id: JID,
          assetTag: "PC1",
          targetIp: "10.0.0.1",
          scriptSnapshot: SNAP,
          claimedAt: new Date("2026-10-19T12:00:00.000Z"),
        },
      ],
    ];
    expect(await claimNextScriptRun("w1")).toMatchObject({
      id: JID,
      scriptSnapshot: SNAP,
      workerId: "w1",
    });
  });
});

describe("script run terminal audit", () => {
  const fence = { workerId: "w1", claimedAt: "2026-10-19T12:00:00.000Z" };

  it("refreshes the summary with the exit code on success", async () => {
    H.state.updateReturns = [
      [{ id: JID, assetId: "a1", snapshot: SNAP, requestedBy: "me" }],
    ];
    expect(
      await updateScriptRunStatus(JID, {
        ...fence,
        status: "succeeded",
        result: { exitCode: 0, outputTail: null },
      }),
    ).toBe("ok");
    expect(updateAuditMock).toHaveBeenCalledWith({
      sourceTable: "script_run_jobs",
      sourceId: JID,
      status: "succeeded",
      summary: "Ran Clear spooler (exit 0)",
    });
  });

  it("does not touch audit while the run is still going", async () => {
    H.state.updateReturns = [
      [{ id: JID, assetId: "a1", snapshot: SNAP, requestedBy: "me" }],
    ];
    expect(
      await updateScriptRunStatus(JID, { ...fence, status: "running" }),
    ).toBe("ok");
    expect(updateAuditMock).not.toHaveBeenCalled();
  });

  it("cancels the audit row", async () => {
    H.state.updateReturns = [[{ id: JID }]];
    expect(await cancelScriptRun(JID)).toBe(true);
    expect(updateAuditMock).toHaveBeenCalledWith({
      sourceTable: "script_run_jobs",
      sourceId: JID,
      status: "canceled",
    });
  });
});
