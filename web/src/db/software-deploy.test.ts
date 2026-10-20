import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the software-deployment queue (spec 23). The DB client is the
 * boundary and is mocked; the logic under test is the enqueue in-flight guard, the
 * target resolution, the claim shape, the fenced status update, and cancel. Traces:
 *   AC-2   resolveDeployTarget (Computer + IP) / enqueue
 *   AC-10  enqueue one-in-flight-per-target guard; cancel
 *   AC-3   claim shape; fenced updateDeploymentStatus (stale vs notfound)
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
  const notifyMock = vi.fn();

  return { state, selectMock, insertMock, updateMock, executeMock, notifyMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/scan", () => ({ isWorkerLive: vi.fn().mockResolvedValue(true) }));
vi.mock("@/db/notifications", () => ({ notifyDeployResult: H.notifyMock }));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
    execute: H.executeMock,
  },
}));

import {
  resolveDeployTarget,
  enqueueDeployment,
  claimNextDeployment,
  updateDeploymentStatus,
  cancelDeployment,
} from "./software-deploy";

const DID = "0959927f-1046-4582-9a70-60a4175f206b";
const FENCE = { workerId: "w1", claimedAt: "2026-10-12T10:00:00.000Z" };
const SNAP = {
  name: "App",
  version: "1.0",
  steps: [
    {
      id: "s1",
      kind: "install" as const,
      name: "App",
      installerType: "msi" as const,
      fileName: "app.msi",
      silentArgs: "",
      sha256: "abc",
      storageKey: "software/x/y.msi",
      fileSize: 10,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.updateReturns = [];
  H.state.updateSets = [];
  H.state.execResult = [];
});

describe("resolveDeployTarget (AC-2)", () => {
  it("resolves a Computer with an IP", async () => {
    H.state.selects = [[{ assetId: "a1", type: "Computer", ip: "192.168.70.5" }]];
    expect(await resolveDeployTarget("PC-1")).toEqual({
      assetId: "a1",
      ip: "192.168.70.5",
    });
  });

  it("refuses a non-Computer or an IP-less asset", async () => {
    H.state.selects = [[{ assetId: "a1", type: "Printer", ip: "1.2.3.4" }]];
    expect(await resolveDeployTarget("PRN")).toBeNull();
    H.state.selects = [[{ assetId: "a1", type: "Computer", ip: null }]];
    expect(await resolveDeployTarget("PC-2")).toBeNull();
  });
});

describe("enqueueDeployment — one-in-flight guard (AC-10)", () => {
  it("refuses when a deployment is already in flight for the computer", async () => {
    H.state.selects = [[{ id: "existing" }]];
    expect(
      await enqueueDeployment({
        assetId: "a1",
        targetIp: "1.2.3.4",
        packageId: "p1",
        packageSnapshot: SNAP,
        requestedBy: "me",
      }),
    ).toEqual({ ok: false, reason: "already-inflight" });
  });

  it("enqueues when the computer is free", async () => {
    H.state.selects = [[]]; // nothing in flight
    H.state.insertReturns = [[{ id: DID }]];
    expect(
      await enqueueDeployment({
        assetId: "a1",
        targetIp: "1.2.3.4",
        packageId: "p1",
        packageSnapshot: SNAP,
        requestedBy: "me",
      }),
    ).toEqual({ ok: true, id: DID });
  });
});

describe("claimNextDeployment (AC-3)", () => {
  it("returns null when the queue is empty", async () => {
    H.state.execResult = []; // no row claimed
    expect(await claimNextDeployment("w1")).toBeNull();
  });

  it("returns the claimed deployment with its frozen snapshot", async () => {
    H.state.execResult = [{ id: DID }];
    H.state.selects = [
      [
        {
          id: DID,
          assetTag: "PC-1",
          targetIp: "192.168.70.5",
          packageSnapshot: SNAP,
          claimedAt: new Date("2026-10-12T10:00:00.000Z"),
        },
      ],
    ];
    expect(await claimNextDeployment("w1")).toEqual({
      id: DID,
      assetTag: "PC-1",
      targetIp: "192.168.70.5",
      packageSnapshot: SNAP,
      workerId: "w1",
      claimedAt: "2026-10-12T10:00:00.000Z",
    });
  });
});

describe("updateDeploymentStatus — fenced (AC-3)", () => {
  it("is ok when the fenced update applies", async () => {
    H.state.updateReturns = [[{ id: DID }]];
    expect(
      await updateDeploymentStatus(DID, { ...FENCE, status: "running" }),
    ).toBe("ok");
    expect(H.state.updateSets[0]).toMatchObject({ status: "running" });
  });

  it("notifies on a successful finish", async () => {
    H.state.updateReturns = [
      [{ id: DID, assetId: "a1", snapshot: SNAP, requestedBy: "me@x.com" }],
    ];
    expect(
      await updateDeploymentStatus(DID, { ...FENCE, status: "succeeded" }),
    ).toBe("ok");
    expect(H.notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: DID,
        status: "succeeded",
        packageName: "App",
        requestedBy: "me@x.com",
      }),
    );
  });

  it("is stale when the row exists but the claim lost", async () => {
    H.state.updateReturns = [[]];
    H.state.selects = [[{ id: DID }]];
    expect(
      await updateDeploymentStatus(DID, { ...FENCE, status: "succeeded" }),
    ).toBe("stale");
  });

  it("is notfound when no row matches at all", async () => {
    H.state.updateReturns = [[]];
    H.state.selects = [[]];
    expect(
      await updateDeploymentStatus(DID, { ...FENCE, status: "failed", error: "boom" }),
    ).toBe("notfound");
  });
});

describe("cancelDeployment (AC-10)", () => {
  it("cancels an in-flight deployment", async () => {
    H.state.updateReturns = [[{ id: DID }]];
    expect(await cancelDeployment(DID)).toBe(true);
    expect(H.state.updateSets[0]).toMatchObject({ status: "canceled" });
  });

  it("returns false for an already-terminal / unknown deployment", async () => {
    H.state.updateReturns = [[]];
    expect(await cancelDeployment(DID)).toBe(false);
  });
});
