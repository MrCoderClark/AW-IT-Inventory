import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the patch-install queue (spec 31 phase 3).
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
  const deleteMock = vi.fn(() => ({
    where: () => Promise.resolve([]),
  }));
  const notifyMock = vi.fn();
  const resolveDeployTargetMock = vi.fn();
  const enqueueScanMock = vi.fn().mockResolvedValue("scan-1");
  const enqueueMissingCheckMock = vi.fn().mockResolvedValue({ ok: true, id: "c1" });
  const syncLinkedRebootsMock = vi.fn();

  return {
    state,
    selectMock,
    insertMock,
    updateMock,
    executeMock,
    deleteMock,
    notifyMock,
    resolveDeployTargetMock,
    enqueueScanMock,
    enqueueMissingCheckMock,
    syncLinkedRebootsMock,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/scan", () => ({
  isWorkerLive: vi.fn().mockResolvedValue(true),
  enqueueScan: (...args: unknown[]) => H.enqueueScanMock(...args),
}));
vi.mock("@/db/missing-update-checks", () => ({
  enqueueMissingUpdateCheck: (...args: unknown[]) =>
    H.enqueueMissingCheckMock(...args),
}));
vi.mock("@/db/notifications", () => ({
  notifyPatchInstallResult: H.notifyMock,
}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
    delete: H.deleteMock,
    execute: H.executeMock,
  },
}));
vi.mock("@/db/software-deploy", () => ({
  resolveDeployTarget: (...args: unknown[]) =>
    H.resolveDeployTargetMock(...args),
}));
vi.mock("@/db/reboot", () => ({
  syncLinkedRebootsForInstall: (...args: unknown[]) =>
    H.syncLinkedRebootsMock(...args),
}));

import {
  buildPatchSelection,
  enqueuePatchInstall,
  enqueueFleetOsPatchInstalls,
  claimNextPatchInstall,
  updatePatchInstallStatus,
  cancelPatchInstall,
} from "./patch-install";

const JID = "0959927f-1046-4582-9a70-60a4175f206b";
const FENCE = { workerId: "w1", claimedAt: "2026-10-19T10:00:00.000Z" };
const SEL = {
  os: [{ kbId: "KB1", title: "Security Update" }],
  apps: [
    {
      packageId: "Google.Chrome",
      name: "Chrome",
      version: "1",
      available: "2",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PATCH_INSTALL_MAX_CONCURRENT;
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.updateReturns = [];
  H.state.updateSets = [];
  H.state.execResult = [];
});

describe("buildPatchSelection (AC-15)", () => {
  it("rejects an empty selection", async () => {
    expect(await buildPatchSelection("a1", [], [])).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("rejects unknown ids", async () => {
    H.state.selects = [[{ kbId: "KB1", title: "Ok" }]]; // missing one of two
    expect(await buildPatchSelection("a1", ["KB1", "KB2"], [])).toEqual({
      ok: false,
      reason: "unknown-ids",
    });
  });

  it("builds a frozen selection from inventory", async () => {
    H.state.selects = [
      [{ kbId: "KB1", title: "Security Update" }],
      [
        {
          packageId: "Google.Chrome",
          name: "Chrome",
          version: "1",
          available: "2",
        },
      ],
    ];
    expect(
      await buildPatchSelection("a1", ["KB1"], ["Google.Chrome"]),
    ).toEqual({ ok: true, selection: SEL });
  });
});

describe("enqueuePatchInstall — one-in-flight (AC-15)", () => {
  it("refuses when a job is already in flight", async () => {
    H.state.selects = [[{ id: "existing" }]];
    expect(
      await enqueuePatchInstall({
        assetId: "a1",
        targetIp: "1.2.3.4",
        selection: SEL,
        requestedBy: "me",
      }),
    ).toEqual({ ok: false, reason: "already-inflight" });
  });

  it("enqueues when the computer is free", async () => {
    H.state.selects = [[]];
    H.state.insertReturns = [[{ id: JID }]];
    expect(
      await enqueuePatchInstall({
        assetId: "a1",
        targetIp: "1.2.3.4",
        selection: SEL,
        requestedBy: "me",
      }),
    ).toEqual({ ok: true, id: JID });
  });
});

describe("claimNextPatchInstall (AC-17)", () => {
  it("returns null when empty", async () => {
    H.state.execResult = [];
    expect(await claimNextPatchInstall("w1")).toBeNull();
  });

  it("returns the claimed job with frozen selection", async () => {
    H.state.execResult = [{ id: JID }];
    H.state.selects = [
      [{ n: 0 }],
      [
        {
          id: JID,
          assetTag: "PC-1",
          targetIp: "192.168.70.5",
          selection: SEL,
          claimedAt: new Date("2026-10-19T10:00:00.000Z"),
        },
      ],
    ];
    expect(await claimNextPatchInstall("w1")).toEqual({
      id: JID,
      assetTag: "PC-1",
      targetIp: "192.168.70.5",
      selection: SEL,
      workerId: "w1",
      claimedAt: "2026-10-19T10:00:00.000Z",
    });
  });
});

describe("claimNextPatchInstall — fleet concurrency", () => {
  it("returns null when claimed|running count is at max", async () => {
    process.env.PATCH_INSTALL_MAX_CONCURRENT = "2";
    H.state.selects = [[{ n: 2 }]];
    expect(await claimNextPatchInstall("w1")).toBeNull();
    expect(H.executeMock).not.toHaveBeenCalled();
  });

  it("claims when under max", async () => {
    process.env.PATCH_INSTALL_MAX_CONCURRENT = "2";
    H.state.selects = [
      [{ n: 1 }],
      [
        {
          id: JID,
          assetTag: "PC-1",
          targetIp: "192.168.70.5",
          selection: SEL,
          claimedAt: new Date("2026-10-19T10:00:00.000Z"),
        },
      ],
    ];
    H.state.execResult = [{ id: JID }];
    expect(await claimNextPatchInstall("w1")).toMatchObject({ id: JID });
  });
});

describe("updatePatchInstallStatus — fenced (AC-17)", () => {
  it("notifies on success", async () => {
    H.state.updateReturns = [
      [
        {
          id: JID,
          assetId: "a1",
          targetIp: "192.168.70.5",
          selection: SEL,
          requestedBy: "me@x.com",
        },
      ],
    ];
    expect(
      await updatePatchInstallStatus(JID, { ...FENCE, status: "succeeded" }),
    ).toBe("ok");
    expect(H.notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JID,
        status: "succeeded",
        osCount: 1,
        appCount: 1,
        requestedBy: "me@x.com",
      }),
    );
  });

  it("enqueues scan + Check updates when selection has both", async () => {
    H.state.updateReturns = [
      [
        {
          id: JID,
          assetId: "a1",
          targetIp: "192.168.70.5",
          selection: SEL,
          requestedBy: "me@x.com",
        },
      ],
    ];
    await updatePatchInstallStatus(JID, { ...FENCE, status: "succeeded" });
    expect(H.enqueueScanMock).toHaveBeenCalledWith({
      scope: "selected",
      targets: ["192.168.70.5"],
      requestedBy: "patch-install:me@x.com",
    });
    expect(H.enqueueMissingCheckMock).toHaveBeenCalledWith({
      assetId: "a1",
      targetIp: "192.168.70.5",
      requestedBy: "patch-install:me@x.com",
    });
  });

  it("enqueues only a scan for app-only success", async () => {
    H.state.updateReturns = [
      [
        {
          id: JID,
          assetId: "a1",
          targetIp: "192.168.70.5",
          selection: { os: [], apps: SEL.apps },
          requestedBy: "me@x.com",
        },
      ],
    ];
    await updatePatchInstallStatus(JID, { ...FENCE, status: "succeeded" });
    expect(H.enqueueScanMock).toHaveBeenCalled();
    expect(H.enqueueMissingCheckMock).not.toHaveBeenCalled();
  });

  it("enqueues only Check updates for OS-only success", async () => {
    H.state.updateReturns = [
      [
        {
          id: JID,
          assetId: "a1",
          targetIp: "192.168.70.5",
          selection: { os: SEL.os, apps: [] },
          requestedBy: "me@x.com",
        },
      ],
    ];
    // remaining missing rows after delete (none → count 0)
    H.state.selects = [[]];
    await updatePatchInstallStatus(JID, {
      ...FENCE,
      status: "succeeded",
      result: {
        items: [{ kind: "os", id: "KB1", ok: true, exitCode: 2 }],
        rebootRequired: false,
      },
    });
    expect(H.enqueueScanMock).not.toHaveBeenCalled();
    expect(H.enqueueMissingCheckMock).toHaveBeenCalledWith({
      assetId: "a1",
      targetIp: "192.168.70.5",
      requestedBy: "patch-install:me@x.com",
    });
    expect(H.deleteMock).toHaveBeenCalled();
  });

  it("clears installed OS from Missing and skips Check when reboot required", async () => {
    H.state.updateReturns = [
      [
        {
          id: JID,
          assetId: "a1",
          targetIp: "192.168.70.5",
          selection: { os: SEL.os, apps: [] },
          requestedBy: "me@x.com",
        },
      ],
    ];
    H.state.selects = [[]];
    await updatePatchInstallStatus(JID, {
      ...FENCE,
      status: "succeeded",
      result: {
        items: [{ kind: "os", id: "KB5127648", ok: true, exitCode: 2 }],
        rebootRequired: true,
      },
    });
    expect(H.deleteMock).toHaveBeenCalled();
    expect(H.state.updateSets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pendingReboot: true, missingCount: 0 }),
      ]),
    );
    expect(H.enqueueMissingCheckMock).not.toHaveBeenCalled();
    expect(H.enqueueScanMock).not.toHaveBeenCalled();
  });

  it("does not enqueue follow-ups on failure", async () => {
    H.state.updateReturns = [
      [
        {
          id: JID,
          assetId: "a1",
          targetIp: "192.168.70.5",
          selection: SEL,
          requestedBy: "me@x.com",
        },
      ],
    ];
    await updatePatchInstallStatus(JID, {
      ...FENCE,
      status: "failed",
      error: "timeout",
    });
    expect(H.enqueueScanMock).not.toHaveBeenCalled();
    expect(H.enqueueMissingCheckMock).not.toHaveBeenCalled();
  });

  it("is stale when the claim was lost", async () => {
    H.state.updateReturns = [[]];
    H.state.selects = [[{ id: JID }]];
    expect(
      await updatePatchInstallStatus(JID, { ...FENCE, status: "succeeded" }),
    ).toBe("stale");
    expect(H.enqueueScanMock).not.toHaveBeenCalled();
    expect(H.enqueueMissingCheckMock).not.toHaveBeenCalled();
    expect(H.syncLinkedRebootsMock).not.toHaveBeenCalled();
  });

  it("syncs linked reboots on failed terminal status", async () => {
    H.state.updateReturns = [
      [
        {
          id: JID,
          assetId: "a1",
          targetIp: "192.168.70.5",
          selection: SEL,
          requestedBy: "me@x.com",
        },
      ],
    ];
    expect(
      await updatePatchInstallStatus(JID, {
        ...FENCE,
        status: "failed",
        error: "timeout",
      }),
    ).toBe("ok");
    expect(H.syncLinkedRebootsMock).toHaveBeenCalledWith(JID, "failed");
  });

  it("syncs linked reboots on succeeded", async () => {
    H.state.updateReturns = [
      [
        {
          id: JID,
          assetId: "a1",
          targetIp: "192.168.70.5",
          selection: { os: [], apps: SEL.apps },
          requestedBy: "me@x.com",
        },
      ],
    ];
    await updatePatchInstallStatus(JID, { ...FENCE, status: "succeeded" });
    expect(H.syncLinkedRebootsMock).toHaveBeenCalledWith(JID, "succeeded");
  });
});

describe("cancelPatchInstall", () => {
  it("cancels an in-flight job", async () => {
    H.state.updateReturns = [[{ id: JID }]];
    expect(await cancelPatchInstall(JID)).toBe(true);
    expect(H.syncLinkedRebootsMock).toHaveBeenCalledWith(JID, "canceled");
  });
});

describe("enqueueFleetOsPatchInstalls", () => {
  it("enqueues OS-only jobs and skips empty / no-ip / in-flight", async () => {
    H.resolveDeployTargetMock.mockImplementation(async (tag: string) => {
      if (tag === "TAG-A") return { assetId: "a1", ip: "192.168.70.1" };
      if (tag === "TAG-B") return null;
      if (tag === "TAG-C") return { assetId: "a3", ip: "192.168.70.3" };
      if (tag === "TAG-D") return { assetId: "a4", ip: "192.168.70.4" };
      return null;
    });

    H.state.selects = [
      [{ kbId: "KB1" }],
      [{ kbId: "KB1", title: "Security Update" }],
      [],
      [{ kbId: "KB2" }],
      [{ kbId: "KB2", title: "Update 2" }],
      [{ id: "existing" }],
      [],
    ];
    H.state.insertReturns = [[{ id: JID }]];

    const result = await enqueueFleetOsPatchInstalls({
      tags: ["TAG-A", "TAG-B", "TAG-C", "TAG-D"],
      requestedBy: "admin@x.com",
    });

    expect(result.enqueued).toEqual([JID]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { tag: "TAG-B", reason: "no-ip" },
        { tag: "TAG-C", reason: "already-inflight" },
        { tag: "TAG-D", reason: "no-missing" },
      ]),
    );
    expect(result.skipped).toHaveLength(3);
    expect(H.resolveDeployTargetMock).toHaveBeenCalledWith("TAG-A");
  });

  it("returns empty enqueued when tags empty", async () => {
    expect(
      await enqueueFleetOsPatchInstalls({ tags: [], requestedBy: "a@x.com" }),
    ).toEqual({ enqueued: [], skipped: [] });
    expect(H.resolveDeployTargetMock).not.toHaveBeenCalled();
  });
});
