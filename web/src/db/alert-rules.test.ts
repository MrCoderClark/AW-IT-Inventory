import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Spec 30 ingest-time evaluator. DB + createNotification are mocked; the pure
 * tick/episode helpers are real. Locks: fire on disk ≥90 (N=1), CPU needs two
 * samples, a null gauge skips, recovery notifies, a failed send does not
 * advance alertedState.
 */

const H = vi.hoisted(() => {
  const state = {
    selectCalls: 0,
    rules: [] as Record<string, unknown>[],
    assets: [] as Record<string, unknown>[],
    states: [] as Record<string, unknown>[],
    upserts: [] as Record<string, unknown>[],
  };

  const thenable = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "innerJoin", "where", "limit"]) b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return b;
  };

  const selectMock = vi.fn(() => {
    const i = state.selectCalls++;
    if (i === 0) return thenable(state.rules);
    if (i === 1) return thenable(state.assets);
    return thenable(state.states);
  });

  const insertMock = vi.fn(() => ({
    values: (v: unknown) => ({
      onConflictDoNothing: () => Promise.resolve(),
      onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
        state.upserts.push(set);
        return Promise.resolve();
      },
    }),
  }));

  const notifyMock = vi.fn(
    async (_input: Record<string, unknown>) => "notif-id" as string | null,
  );

  return { state, selectMock, insertMock, notifyMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: { select: H.selectMock, insert: H.insertMock },
}));
vi.mock("./notifications", () => ({ createNotification: H.notifyMock }));

import { evaluateMetricAlerts } from "./alert-rules";

const DISK = {
  id: "rule-disk",
  name: "Disk almost full",
  signal: "disk_pct",
  op: "gte",
  threshold: 90,
  consecutive: 1,
  severity: "critical",
  enabled: true,
};
const CPU = {
  id: "rule-cpu",
  name: "CPU high",
  signal: "cpu_pct",
  op: "gte",
  threshold: 90,
  consecutive: 2,
  severity: "warning",
  enabled: true,
};
const ASSET = { id: "a1", tag: "H2TECS-COMP-1", name: "Reception PC" };

function sample(gauges: {
  cpuPct?: number | null;
  memPct?: number | null;
  diskPct?: number | null;
  uptimeSec?: number | null;
}) {
  return {
    assetId: "a1",
    sampledAt: new Date("2026-10-19T15:00:00Z"),
    cpuPct: gauges.cpuPct ?? null,
    memPct: gauges.memPct ?? null,
    diskPct: gauges.diskPct ?? null,
    uptimeSec: gauges.uptimeSec ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selectCalls = 0;
  H.state.rules = [];
  H.state.assets = [ASSET];
  H.state.states = [];
  H.state.upserts = [];
  H.notifyMock.mockResolvedValue("notif-id");
});

describe("evaluateMetricAlerts", () => {
  it("fires on the first disk ≥ 90 sample (consecutive 1)", async () => {
    H.state.rules = [DISK];
    await evaluateMetricAlerts([sample({ diskPct: 97 })]);
    expect(H.notifyMock).toHaveBeenCalledTimes(1);
    expect(H.notifyMock.mock.calls[0][0]).toMatchObject({
      type: "metric-threshold",
      severity: "critical",
      assetId: "a1",
      href: "/assets/H2TECS-COMP-1",
    });
    expect(H.state.upserts[0]).toMatchObject({
      consecutive: 1,
      alertedState: "firing",
    });
  });

  it("does not fire CPU ≥ 90 until the second consecutive sample", async () => {
    H.state.rules = [CPU];
    await evaluateMetricAlerts([sample({ cpuPct: 94 })]);
    expect(H.notifyMock).not.toHaveBeenCalled();
    expect(H.state.upserts[0]).toMatchObject({
      consecutive: 1,
      alertedState: "ok",
    });
  });

  it("fires CPU on the second hot sample", async () => {
    H.state.rules = [CPU];
    H.state.states = [
      { ruleId: "rule-cpu", assetId: "a1", consecutive: 1, alertedState: "ok" },
    ];
    await evaluateMetricAlerts([sample({ cpuPct: 91 })]);
    expect(H.notifyMock.mock.calls[0][0]).toMatchObject({
      type: "metric-threshold",
      severity: "warning",
    });
    expect(H.state.upserts[0]).toMatchObject({
      consecutive: 2,
      alertedState: "firing",
    });
  });

  it("skips a null gauge and does not persist or notify", async () => {
    H.state.rules = [CPU];
    H.state.states = [
      { ruleId: "rule-cpu", assetId: "a1", consecutive: 1, alertedState: "ok" },
    ];
    await evaluateMetricAlerts([sample({ cpuPct: null })]);
    expect(H.notifyMock).not.toHaveBeenCalled();
    expect(H.state.upserts).toEqual([]);
  });

  it("recovers from firing when the sample drops under the threshold", async () => {
    H.state.rules = [DISK];
    H.state.states = [
      {
        ruleId: "rule-disk",
        assetId: "a1",
        consecutive: 1,
        alertedState: "firing",
      },
    ];
    await evaluateMetricAlerts([sample({ diskPct: 40 })]);
    expect(H.notifyMock.mock.calls[0][0]).toMatchObject({
      type: "metric-recovered",
      severity: "info",
    });
    expect(H.state.upserts[0]).toMatchObject({
      consecutive: 0,
      alertedState: "ok",
    });
  });

  it("does not advance alertedState when the notification write fails", async () => {
    H.state.rules = [DISK];
    H.notifyMock.mockResolvedValue(null);
    await evaluateMetricAlerts([sample({ diskPct: 97 })]);
    expect(H.state.upserts[0]).toMatchObject({
      consecutive: 1,
      alertedState: null,
    });
  });
});
