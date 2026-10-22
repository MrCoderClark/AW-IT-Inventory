import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for scheduled reboot queue (spec 31 v2).
 */

const H = vi.hoisted(() => {
  const state: {
    selects: unknown[][];
    insertReturns: unknown[][];
    updateReturns: unknown[][];
    updateSets: Record<string, unknown>[];
    execResult: unknown[];
  } = {
    selects: [],
    insertReturns: [],
    updateReturns: [],
    updateSets: [],
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
  const selectMock = vi.fn(() => makeSelect());

  const insertMock = vi.fn(() => ({
    values: () => ({
      returning: () => Promise.resolve(state.insertReturns.shift() ?? []),
    }),
  }));

  const updateMock = vi.fn(() => ({
    set: (vals: Record<string, unknown>) => {
      state.updateSets.push(vals);
      return {
        where: () => {
          const p = Promise.resolve() as Promise<unknown> & {
            returning?: () => Promise<unknown>;
          };
          p.returning = () => Promise.resolve(state.updateReturns.shift() ?? []);
          return p;
        },
      };
    },
  }));

  const executeMock = vi.fn(() => Promise.resolve(state.execResult));

  return {
    state,
    selectMock,
    insertMock,
    updateMock,
    executeMock,
  };
});

vi.mock("server-only", () => ({}));
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
  enqueueRebootJob,
  claimNextReboot,
  updateRebootStatus,
  cancelRebootJob,
  syncLinkedRebootsForInstall,
} from "./reboot";

const JID = "0959927f-1046-4582-9a70-60a4175f206b";
const FENCE = { workerId: "w1", claimedAt: "2026-10-19T10:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.REBOOT_STUCK_JOB_TIMEOUT_MS;
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.updateReturns = [];
  H.state.updateSets = [];
  H.state.execResult = [];
});

describe("enqueueRebootJob", () => {
  it("rejects scheduledAt in the past", async () => {
    const past = new Date(Date.now() - 120_000);
    expect(
      await enqueueRebootJob({
        assetId: "a1",
        targetIp: "1.2.3.4",
        scheduledAt: past,
        requestedBy: "me",
      }),
    ).toEqual({ ok: false, reason: "past-schedule" });
    expect(H.selectMock).not.toHaveBeenCalled();
  });

  it("rejects second in-flight reboot for same asset", async () => {
    H.state.selects = [[{ id: "existing" }]];
    const soon = new Date(Date.now() + 3600_000);
    expect(
      await enqueueRebootJob({
        assetId: "a1",
        targetIp: "1.2.3.4",
        scheduledAt: soon,
        requestedBy: "me",
      }),
    ).toEqual({ ok: false, reason: "already-inflight" });
  });

  it("enqueues when schedule is valid and asset is free", async () => {
    H.state.selects = [[]];
    H.state.insertReturns = [[{ id: JID }]];
    const soon = new Date(Date.now() + 3600_000);
    expect(
      await enqueueRebootJob({
        assetId: "a1",
        targetIp: "1.2.3.4",
        scheduledAt: soon,
        requestedBy: "me",
        sourcePatchInstallJobId: "install-1",
      }),
    ).toEqual({ ok: true, id: JID });
  });
});

describe("claimNextReboot", () => {
  it("returns null when scheduledAt in the future", async () => {
    H.state.execResult = [];
    expect(await claimNextReboot("w1")).toBeNull();
  });

  it("returns null for linked job until install succeeded", async () => {
    H.state.execResult = [];
    expect(await claimNextReboot("w1")).toBeNull();
    expect(H.executeMock).toHaveBeenCalled();
  });

  it("returns job when due and standalone", async () => {
    H.state.execResult = [{ id: JID }];
    H.state.selects = [
      [
        {
          id: JID,
          assetTag: "PC-1",
          targetIp: "192.168.70.5",
          scheduledAt: new Date("2026-10-19T09:00:00.000Z"),
          sourcePatchInstallJobId: null,
          claimedAt: new Date("2026-10-19T10:00:00.000Z"),
        },
      ],
    ];
    expect(await claimNextReboot("w1")).toEqual({
      id: JID,
      assetTag: "PC-1",
      targetIp: "192.168.70.5",
      scheduledAt: "2026-10-19T09:00:00.000Z",
      sourcePatchInstallJobId: null,
      workerId: "w1",
      claimedAt: "2026-10-19T10:00:00.000Z",
    });
  });

  it("returns linked job ASAP when install succeeded and scheduledAt past", async () => {
    const installId = "11111111-1111-4111-8111-111111111111";
    H.state.execResult = [{ id: JID }];
    H.state.selects = [
      [
        {
          id: JID,
          assetTag: "PC-2",
          targetIp: "192.168.70.6",
          scheduledAt: new Date("2026-10-19T08:00:00.000Z"),
          sourcePatchInstallJobId: installId,
          claimedAt: new Date("2026-10-19T10:00:00.000Z"),
        },
      ],
    ];
    expect(await claimNextReboot("w1")).toMatchObject({
      id: JID,
      sourcePatchInstallJobId: installId,
    });
  });
});

describe("updateRebootStatus — fenced", () => {
  it("returns ok on successful update", async () => {
    H.state.updateReturns = [[{ id: JID }]];
    expect(
      await updateRebootStatus(JID, { ...FENCE, status: "succeeded" }),
    ).toBe("ok");
  });

  it("is stale when the claim was lost", async () => {
    H.state.updateReturns = [[]];
    H.state.selects = [[{ id: JID }]];
    expect(
      await updateRebootStatus(JID, { ...FENCE, status: "succeeded" }),
    ).toBe("stale");
  });
});

describe("cancelRebootJob", () => {
  it("cancels an in-flight job", async () => {
    H.state.updateReturns = [[{ id: JID }]];
    expect(await cancelRebootJob(JID)).toBe(true);
  });
});

describe("syncLinkedRebootsForInstall", () => {
  it("cancels on failed", async () => {
    await syncLinkedRebootsForInstall("install-1", "failed");
    expect(H.updateMock).toHaveBeenCalled();
    expect(H.state.updateSets[0]).toMatchObject({ status: "canceled" });
  });

  it("cancels on canceled", async () => {
    await syncLinkedRebootsForInstall("install-1", "canceled");
    expect(H.updateMock).toHaveBeenCalled();
    expect(H.state.updateSets[0]).toMatchObject({ status: "canceled" });
  });

  it("no-ops on succeeded", async () => {
    await syncLinkedRebootsForInstall("install-1", "succeeded");
    expect(H.updateMock).not.toHaveBeenCalled();
  });
});
