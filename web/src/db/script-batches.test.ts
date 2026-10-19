import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const state: {
    insertReturns: unknown[][];
  } = { insertReturns: [] };
  return {
    state,
    insertMock: vi.fn(() => ({
      values: () => ({
        returning: () => Promise.resolve(state.insertReturns.shift() ?? []),
      }),
    })),
    updateMock: vi.fn(() => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    })),
    resolveMock: vi.fn(),
    enqueueMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    insert: H.insertMock,
    update: H.updateMock,
  },
}));
vi.mock("@/db/script-targets", () => ({
  resolveScriptTargets: H.resolveMock,
}));
vi.mock("@/db/script-runs", () => ({
  enqueueScriptRun: H.enqueueMock,
}));

import { enqueueScriptBatch } from "./script-batches";

const SNAP = { name: "Clear spooler", body: "1", timeoutSeconds: 120 };
const BID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

beforeEach(() => {
  vi.clearAllMocks();
  H.state.insertReturns = [];
});

describe("enqueueScriptBatch", () => {
  it("creates a batch and enqueues per host, soft-skipping in-flight", async () => {
    H.resolveMock.mockResolvedValue({
      resolved: [
        { assetId: "a1", tag: "T1", ip: "1.1.1.1" },
        { assetId: "a2", tag: "T2", ip: "1.1.1.2" },
      ],
      skippedNoIp: 1,
    });
    H.state.insertReturns = [[{ id: BID }]];
    H.enqueueMock
      .mockResolvedValueOnce({ ok: true, id: "j1" })
      .mockResolvedValueOnce({ ok: false, reason: "already-inflight" });

    const res = await enqueueScriptBatch({
      scriptId: "s1",
      scriptSnapshot: SNAP,
      targetSpec: { mode: "tags", tags: ["T1", "T2"] },
      source: "manual",
      requestedBy: "me@x",
    });

    expect(res).toEqual({
      batchId: BID,
      enqueued: 1,
      skippedNoIp: 1,
      skippedInflight: 1,
    });
    expect(H.enqueueMock).toHaveBeenCalledTimes(2);
    expect(H.enqueueMock.mock.calls[0][0].batchId).toBe(BID);
    expect(H.updateMock).toHaveBeenCalled();
  });
});
