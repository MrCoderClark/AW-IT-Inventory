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
    /** When true, seedDefaultAlertRules sees an existing row and skips insert. */
    hasRows: true,
    rules: [] as Record<string, unknown>[],
    assets: [] as Record<string, unknown>[],
    states: [] as Record<string, unknown>[],
    upserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    updateReturning: [] as Record<string, unknown>[],
    deleteReturning: [] as Record<string, unknown>[],
    inserts: [] as unknown[],
  };

  const thenable = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "innerJoin", "where", "limit", "orderBy"]) b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return b;
  };

  const selectMock = vi.fn(() => {
    const i = state.selectCalls++;
    // 0 = seed emptiness check; 1 = enabled rules (evaluate) or full list (admin)
    if (i === 0) return thenable(state.hasRows ? [{ id: "seeded" }] : []);
    if (i === 1) return thenable(state.rules);
    if (i === 2) return thenable(state.assets);
    return thenable(state.states);
  });

  const insertMock = vi.fn(() => ({
    values: (v: unknown) => {
      state.inserts.push(v);
      const row = Array.isArray(v)
        ? v[0]
        : { id: "new-id", enabled: true, ...(v as object) };
      return {
        then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve().then(res, rej),
        onConflictDoNothing: () => Promise.resolve(),
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
          state.upserts.push(set);
          return Promise.resolve();
        },
        returning: () => Promise.resolve([row]),
      };
    },
  }));

  const updateMock = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      state.updates.push(v);
      return {
        where: () => ({
          returning: () => Promise.resolve(state.updateReturning),
        }),
      };
    },
  }));

  const deleteMock = vi.fn(() => ({
    where: () => ({
      returning: () => Promise.resolve(state.deleteReturning),
    }),
  }));

  const notifyMock = vi.fn(
    async (_input: Record<string, unknown>) => "notif-id" as string | null,
  );

  const emailMock = vi.fn(async (_p: Record<string, unknown>) => true);

  return {
    state,
    selectMock,
    insertMock,
    updateMock,
    deleteMock,
    notifyMock,
    emailMock,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
    delete: H.deleteMock,
  },
}));
vi.mock("./notifications", () => ({ createNotification: H.notifyMock }));
vi.mock("@/lib/notify", () => ({ sendAlertRuleEmail: H.emailMock }));

import {
  createAlertRule,
  deleteAlertRule,
  evaluateMetricAlerts,
  listAlertRules,
  setAlertRuleEnabled,
  updateAlertRule,
} from "./alert-rules";

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
  H.state.hasRows = true;
  H.state.rules = [];
  H.state.assets = [ASSET];
  H.state.states = [];
  H.state.upserts = [];
  H.state.updates = [];
  H.state.updateReturning = [];
  H.state.deleteReturning = [];
  H.state.inserts = [];
  H.notifyMock.mockResolvedValue("notif-id");
  H.emailMock.mockResolvedValue(true);
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
    expect(H.emailMock).toHaveBeenCalledTimes(1);
    expect(H.emailMock.mock.calls[0][0]).toMatchObject({
      computer: { name: "Reception PC", tag: "H2TECS-COMP-1" },
      event: "firing",
      rule: { name: "Disk almost full", severity: "critical" },
      value: "97%",
    });
  });

  it("does not fire CPU ≥ 90 until the second consecutive sample", async () => {
    H.state.rules = [CPU];
    await evaluateMetricAlerts([sample({ cpuPct: 94 })]);
    expect(H.notifyMock).not.toHaveBeenCalled();
    expect(H.emailMock).not.toHaveBeenCalled();
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
    expect(H.emailMock).not.toHaveBeenCalled();
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
    expect(H.emailMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "recovered" }),
    );
  });

  it("does not advance alertedState when the notification write fails", async () => {
    H.state.rules = [DISK];
    H.notifyMock.mockResolvedValue(null);
    await evaluateMetricAlerts([sample({ diskPct: 97 })]);
    expect(H.state.upserts[0]).toMatchObject({
      consecutive: 1,
      alertedState: null,
    });
    expect(H.emailMock).not.toHaveBeenCalled();
  });

  it("still advances the episode when the email fails (AC-6)", async () => {
    H.state.rules = [DISK];
    H.emailMock.mockResolvedValue(false);
    await evaluateMetricAlerts([sample({ diskPct: 97 })]);
    expect(H.notifyMock).toHaveBeenCalledTimes(1);
    expect(H.state.upserts[0]).toMatchObject({ alertedState: "firing" });
  });
});

const RULE_INPUT = {
  name: "CPU high",
  signal: "cpu_pct" as const,
  op: "gte" as const,
  threshold: 90,
  consecutive: 2,
  severity: "warning" as const,
};

const RULE_ID = "a3000000-0000-4000-8000-000000000001";

describe("listAlertRules (AC-1, AC-7)", () => {
  it("returns existing rows without re-inserting defaults", async () => {
    H.state.rules = [{ ...DISK, enabled: false }];
    const rows = await listAlertRules();
    expect(rows).toEqual([
      expect.objectContaining({ name: "Disk almost full", enabled: false }),
    ]);
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("seeds defaults when the table is empty", async () => {
    H.state.hasRows = false;
    H.state.rules = [];
    await listAlertRules();
    expect(H.state.inserts[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "CPU high" }),
        expect.objectContaining({ name: "Disk almost full" }),
      ]),
    );
  });
});

describe("createAlertRule / updateAlertRule / deleteAlertRule (AC-1)", () => {
  it("inserts an enabled rule and returns the new row", async () => {
    const row = await createAlertRule(RULE_INPUT);
    expect(row).toMatchObject({ ...RULE_INPUT, enabled: true, id: "new-id" });
    expect(H.state.inserts[0]).toMatchObject({
      name: "CPU high",
      enabled: true,
    });
  });

  it("updates a rule by id", async () => {
    H.state.updateReturning = [{ id: RULE_ID, ...RULE_INPUT, enabled: true }];
    const row = await updateAlertRule(RULE_ID, RULE_INPUT);
    expect(row).toMatchObject({ id: RULE_ID, name: "CPU high" });
    expect(H.state.updates[0]).toMatchObject({ name: "CPU high", threshold: 90 });
  });

  it("returns null for an unknown or invalid id on update", async () => {
    expect(await updateAlertRule("not-a-uuid", RULE_INPUT)).toBeNull();
    expect(H.updateMock).not.toHaveBeenCalled();
    H.state.updateReturning = [];
    expect(await updateAlertRule(RULE_ID, RULE_INPUT)).toBeNull();
  });

  it("deletes by id and reports whether a row was removed", async () => {
    expect(await deleteAlertRule("nope")).toBe(false);
    H.state.deleteReturning = [{ id: RULE_ID }];
    expect(await deleteAlertRule(RULE_ID)).toBe(true);
    H.state.deleteReturning = [];
    expect(await deleteAlertRule(RULE_ID)).toBe(false);
  });
});

describe("setAlertRuleEnabled (AC-1)", () => {
  it("flips enabled and returns the updated row", async () => {
    H.state.updateReturning = [
      { id: RULE_ID, ...RULE_INPUT, enabled: false },
    ];
    const row = await setAlertRuleEnabled(RULE_ID, false);
    expect(row).toMatchObject({ enabled: false });
    expect(H.state.updates[0]).toMatchObject({ enabled: false });
  });
});
