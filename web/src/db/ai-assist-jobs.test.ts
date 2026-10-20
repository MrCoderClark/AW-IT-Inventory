import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const state: {
    selects: unknown[][];
    insertReturns: unknown[][];
    inserts: unknown[];
    updates: unknown[];
    updateReturns: unknown[][];
    limits: number[];
    orderBys: number;
  } = {
    selects: [],
    insertReturns: [],
    inserts: [],
    updates: [],
    updateReturns: [],
    limits: [],
    orderBys: 0,
  };
  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "leftJoin", "innerJoin", "where"]) b[m] = self;
    b.orderBy = () => {
      state.orderBys += 1;
      return b;
    };
    b.limit = (n: number) => {
      state.limits.push(n);
      return b;
    };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selects.shift() ?? []).then(res, rej);
    return b;
  };
  return {
    state,
    selectMock: vi.fn(() => makeSelect()),
    insertMock: vi.fn(() => ({
      values: (vals: unknown) => {
        state.inserts.push(vals);
        return {
          returning: () => Promise.resolve(state.insertReturns.shift() ?? []),
        };
      },
    })),
    updateMock: vi.fn(() => ({
      set: (vals: unknown) => {
        state.updates.push(vals);
        return {
          where: () => {
            const p = Promise.resolve() as Promise<unknown> & {
              returning?: () => Promise<unknown>;
            };
            p.returning = () =>
              Promise.resolve(state.updateReturns.shift() ?? [{ id: "updated" }]);
            return p;
          },
        };
      },
    })),
    configuredMock: vi.fn(() => true),
    coreMock: vi.fn(),
    notifyMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/config", () => ({
  isAiConfigured: H.configuredMock,
}));
vi.mock("@/db/ai-assist", () => ({
  executeAssistCore: H.coreMock,
}));
vi.mock("@/db/notifications", () => ({
  notifyAiAssistResult: H.notifyMock,
}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
  },
}));

import {
  STUCK_MS,
  enqueueAssistJob,
  getAssistJob,
  listAssistJobsForAssetTag,
  processAssistJob,
  reclaimStuckAssistJobs,
} from "./ai-assist-jobs";

const JOB = "0959927f-1046-4582-9a70-60a4175f206b";
const ASSET = "11111111-1111-4111-8111-111111111111";
const SCRIPT = "22222222-2222-4222-8222-222222222222";
const RESULT = {
  observed: ["disk 90%"],
  hypotheses: ["logs"],
  recommendations: ["clear temp"],
};

const PENDING = {
  id: JOB,
  status: "pending" as const,
  actorEmail: "tech@example.com",
  assetId: ASSET,
  action: "summarize_script_run",
  scriptRunJobId: SCRIPT,
  userPrompt: "why did it fail",
  assetTag: "PC-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  H.configuredMock.mockReturnValue(true);
  H.notifyMock.mockResolvedValue("notif-1");
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.inserts = [];
  H.state.updates = [];
  H.state.updateReturns = [];
  H.state.limits = [];
  H.state.orderBys = 0;
});

describe("STUCK_MS", () => {
  it("is 10 minutes", () => {
    expect(STUCK_MS).toBe(10 * 60 * 1000);
  });
});

describe("enqueueAssistJob", () => {
  it("reclaims first and refuses when AI is not configured", async () => {
    H.configuredMock.mockReturnValue(false);
    H.state.selects = [[]];
    expect(
      await enqueueAssistJob({
        action: "summarize_health",
        assetTag: "PC-1",
        actorEmail: "tech@example.com",
      }),
    ).toEqual({ error: "not_configured" });
    expect(H.selectMock).toHaveBeenCalled();
    expect(H.insertMock).not.toHaveBeenCalled();
    expect(H.notifyMock).not.toHaveBeenCalled();
  });

  it("returns not_found when the computer is missing", async () => {
    H.state.selects = [[], []];
    expect(
      await enqueueAssistJob({
        action: "summarize_health",
        assetTag: "missing",
        actorEmail: "tech@example.com",
      }),
    ).toEqual({ error: "not_found" });
    expect(H.insertMock).not.toHaveBeenCalled();
    expect(H.notifyMock).not.toHaveBeenCalled();
  });

  it("inserts a pending job and does not notify", async () => {
    H.state.selects = [[], [{ id: ASSET }]];
    H.state.insertReturns = [[{ id: JOB }]];
    expect(
      await enqueueAssistJob({
        action: "summarize_health",
        assetTag: "PC-1",
        actorEmail: "tech@example.com",
        userPrompt: "check disk",
      }),
    ).toEqual({ id: JOB });
    expect(H.state.inserts[0]).toMatchObject({
      actorEmail: "tech@example.com",
      assetId: ASSET,
      action: "summarize_health",
      scriptRunJobId: null,
      userPrompt: "check disk",
      status: "pending",
    });
    expect(H.notifyMock).not.toHaveBeenCalled();
    expect(H.coreMock).not.toHaveBeenCalled();
  });
});

describe("processAssistJob", () => {
  it("skips a missing or already terminal job", async () => {
    H.state.selects = [[]];
    await processAssistJob(JOB);
    H.state.selects = [[{ ...PENDING, status: "failed" }]];
    await processAssistJob(JOB);
    expect(H.coreMock).not.toHaveBeenCalled();
    expect(H.updateMock).not.toHaveBeenCalled();
    expect(H.notifyMock).not.toHaveBeenCalled();
  });

  it("runs the core, stores success, and notifies once", async () => {
    H.state.selects = [[PENDING]];
    H.coreMock.mockResolvedValue({
      ok: true,
      result: RESULT,
      provider: "openai_compatible",
      model: "local",
      contextHash: "abc",
      assetId: ASSET,
    });
    await processAssistJob(JOB);
    expect(H.coreMock).toHaveBeenCalledWith({
      action: "summarize_script_run",
      assetTag: "PC-1",
      actorEmail: "tech@example.com",
      jobId: SCRIPT,
      userPrompt: "why did it fail",
    });
    expect(H.state.updates[0]).toMatchObject({ status: "running" });
    expect(H.state.updates[0]).toHaveProperty("startedAt");
    expect(H.state.updates[1]).toMatchObject({
      status: "succeeded",
      result: RESULT,
      error: null,
      contextHash: "abc",
      provider: "openai_compatible",
      model: "local",
    });
    expect(H.notifyMock).toHaveBeenCalledTimes(1);
    expect(H.notifyMock).toHaveBeenCalledWith({
      jobId: JOB,
      actorEmail: "tech@example.com",
      assetTag: "PC-1",
      assetId: ASSET,
      action: "summarize_script_run",
      ok: true,
      error: undefined,
    });
    expect(H.state.updates[2]).toEqual({ notificationId: "notif-1" });
  });

  it("marks failed, truncates the error, and notifies", async () => {
    H.state.selects = [[{ ...PENDING, action: "summarize_health", scriptRunJobId: null, userPrompt: null }]];
    H.coreMock.mockResolvedValue({
      ok: false,
      code: "provider_error",
      error: "x".repeat(600),
      provider: "openai_compatible",
      model: "local",
      contextHash: "abc",
      assetId: ASSET,
    });
    await processAssistJob(JOB);
    expect(H.coreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "summarize_health",
        jobId: undefined,
        userPrompt: undefined,
      }),
    );
    const failed = H.state.updates[1] as { status: string; error: string };
    expect(failed.status).toBe("failed");
    expect(failed.error).toHaveLength(500);
    expect(H.notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "x".repeat(500) }),
    );
  });

  it("does not throw when the core throws", async () => {
    H.state.selects = [[PENDING]];
    H.coreMock.mockRejectedValue(new Error("boom"));
    await expect(processAssistJob(JOB)).resolves.toBeUndefined();
    expect(H.state.updates[1]).toMatchObject({ status: "failed", error: "boom" });
    expect(H.notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "boom" }),
    );
  });

  it("does not notify when the terminal write loses a race", async () => {
    H.state.selects = [[PENDING]];
    H.state.updateReturns = [[]];
    H.coreMock.mockResolvedValue({
      ok: true,
      result: RESULT,
      provider: "p",
      model: "m",
      contextHash: "h",
      assetId: ASSET,
    });
    await processAssistJob(JOB);
    expect(H.notifyMock).not.toHaveBeenCalled();
  });

  it("still records failure when marking running throws", async () => {
    H.state.selects = [[PENDING], [PENDING]];
    H.updateMock.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await expect(processAssistJob(JOB)).resolves.toBeUndefined();
    expect(H.state.updates[0]).toMatchObject({
      status: "failed",
      error: "db down",
    });
    expect(H.notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "db down" }),
    );
  });
});

describe("reclaimStuckAssistJobs", () => {
  it("fails stuck running jobs and notifies each actor", async () => {
    H.state.selects = [
      [
        {
          id: JOB,
          actorEmail: "tech@example.com",
          assetId: ASSET,
          action: "explain_failures",
          tag: "PC-1",
        },
      ],
    ];
    H.state.updateReturns = [[{ id: JOB }]];
    expect(await reclaimStuckAssistJobs()).toBe(1);
    expect(H.state.updates[0]).toMatchObject({
      status: "failed",
      error: "Assist interrupted (timed out or server restarted)",
    });
    expect(H.notifyMock).toHaveBeenCalledWith({
      jobId: JOB,
      actorEmail: "tech@example.com",
      assetTag: "PC-1",
      assetId: ASSET,
      action: "explain_failures",
      ok: false,
      error: "Assist interrupted (timed out or server restarted)",
    });
    expect(H.state.updates[1]).toEqual({ notificationId: "notif-1" });
  });

  it("does not notify when the running row was already finished", async () => {
    H.state.selects = [
      [
        {
          id: JOB,
          actorEmail: "tech@example.com",
          assetId: ASSET,
          action: "explain_failures",
          tag: "PC-1",
        },
      ],
    ];
    H.state.updateReturns = [[]];
    expect(await reclaimStuckAssistJobs()).toBe(0);
    expect(H.notifyMock).not.toHaveBeenCalled();
  });
});

describe("getAssistJob / listAssistJobsForAssetTag", () => {
  it("returns one job or null", async () => {
    H.state.selects = [[{ id: JOB, status: "pending" }]];
    expect(await getAssistJob(JOB)).toEqual({ id: JOB, status: "pending" });
    H.state.selects = [[]];
    expect(await getAssistJob("missing")).toBeNull();
  });

  it("lists newest-first with a default limit of 5", async () => {
    H.state.selects = [[{ id: JOB }]];
    expect(await listAssistJobsForAssetTag("PC-1")).toEqual([{ id: JOB }]);
    expect(H.state.limits).toEqual([5]);
    expect(H.state.orderBys).toBe(1);
    await listAssistJobsForAssetTag("PC-1", 2);
    expect(H.state.limits).toEqual([5, 2]);
  });
});
