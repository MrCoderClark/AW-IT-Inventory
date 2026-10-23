import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for recurring reboot schedules (spec 31 v2). The DB client is
 * mocked the same way as reboot.test.ts; next-occurrence math is real.
 */

const H = vi.hoisted(() => {
  const state: {
    selects: unknown[][];
    insertReturns: unknown[][];
    inserts: unknown[];
    updateReturns: unknown[][];
    updateSets: Record<string, unknown>[];
    conflictSets: Record<string, unknown>[];
    deleteReturns: unknown[][];
  } = {
    selects: [],
    insertReturns: [],
    inserts: [],
    updateReturns: [],
    updateSets: [],
    conflictSets: [],
    deleteReturns: [],
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
    values: (vals: unknown) => {
      state.inserts.push(vals);
      const returning = () => Promise.resolve(state.insertReturns.shift() ?? []);
      return {
        returning,
        onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
          state.conflictSets.push(cfg.set);
          return { returning };
        },
      };
    },
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

  const deleteMock = vi.fn(() => ({
    where: () => ({
      returning: () => Promise.resolve(state.deleteReturns.shift() ?? []),
    }),
  }));

  return {
    state,
    selectMock,
    insertMock,
    updateMock,
    deleteMock,
  };
});

const notifyMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("server-only", () => ({}));
vi.mock("@/db/scan", () => ({ isWorkerLive: vi.fn().mockResolvedValue(true) }));
vi.mock("./notifications", () => ({ notifyRebootResult: notifyMock }));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
    delete: H.deleteMock,
  },
}));

import {
  deleteRebootSchedule,
  getRebootScheduleForAssetTag,
  materializeDueRebootSchedules,
  materializeRebootSchedule,
  onScheduleJobTerminal,
  setRebootScheduleEnabled,
  upsertRebootSchedule,
} from "./reboot-schedules";

const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OLD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NEXT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const dailyInput = {
  assetId: ASSET,
  targetIp: "192.168.70.5",
  cadence: "daily" as const,
  weekdays: [3] as number[] | null,
  localTime: "15:30",
  timezone: "America/New_York",
  requestedBy: "ada",
};

function scheduleRow(over: Record<string, unknown> = {}) {
  return {
    id: SCHED,
    assetId: ASSET,
    cadence: "daily",
    weekdays: null,
    localTime: "15:30",
    timezone: "America/New_York",
    enabled: true,
    requestedBy: "ada",
    nextJobId: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

function canceledRow(id: string) {
  return {
    id,
    assetId: ASSET,
    requestedBy: "ada",
    scheduledAt: new Date("2026-10-23T18:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.inserts = [];
  H.state.updateReturns = [];
  H.state.updateSets = [];
  H.state.conflictSets = [];
  H.state.deleteReturns = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("upsertRebootSchedule", () => {
  it("materializes the next reboot job and stores sourceScheduleId", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T14:00:00.000Z"));
    H.state.insertReturns = [
      [{ id: SCHED, nextJobId: null }],
      [{ id: JOB }],
    ];
    H.state.selects = [[], [scheduleRow()], [], []];

    expect(await upsertRebootSchedule(dailyInput)).toEqual({ ok: true, id: SCHED });

    expect(H.state.inserts[0]).toMatchObject({
      assetId: ASSET,
      cadence: "daily",
      weekdays: null,
      localTime: "15:30",
      timezone: "America/New_York",
      enabled: true,
      requestedBy: "ada",
    });
    expect(H.state.conflictSets[0]).toMatchObject({
      cadence: "daily",
      weekdays: null,
      enabled: true,
      localTime: "15:30",
      timezone: "America/New_York",
      requestedBy: "ada",
    });
    expect(H.state.inserts[1]).toMatchObject({
      assetId: ASSET,
      targetIp: "192.168.70.5",
      scheduledAt: new Date("2026-10-23T19:30:00.000Z"),
      requestedBy: "ada",
      sourcePatchInstallJobId: null,
      sourceScheduleId: SCHED,
    });
    expect(H.state.updateSets.at(-1)).toMatchObject({ nextJobId: JOB });
  });

  it("cancels the previous schedule child before booking the next", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T14:00:00.000Z"));
    H.state.insertReturns = [
      [{ id: SCHED, nextJobId: OLD }],
      [{ id: JOB }],
    ];
    H.state.updateReturns = [[canceledRow(OLD)]];
    H.state.selects = [[{ id: OLD }], [scheduleRow()], [], []];

    expect(await upsertRebootSchedule(dailyInput)).toEqual({ ok: true, id: SCHED });
    expect(H.state.updateSets[0]).toMatchObject({ status: "canceled" });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: OLD, status: "canceled" }),
    );
    expect(H.state.inserts[1]).toMatchObject({
      sourceScheduleId: SCHED,
      scheduledAt: new Date("2026-10-23T19:30:00.000Z"),
    });
  });

  it("stores weekdays and the next matching weekday", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    H.state.insertReturns = [
      [{ id: SCHED, nextJobId: null }],
      [{ id: JOB }],
    ];
    H.state.selects = [
      [],
      [scheduleRow({ cadence: "weekly", weekdays: [1], localTime: "02:00" })],
      [],
      [],
    ];

    expect(
      await upsertRebootSchedule({
        ...dailyInput,
        cadence: "weekly",
        weekdays: [1],
        localTime: "02:00",
      }),
    ).toEqual({ ok: true, id: SCHED });
    expect(H.state.inserts[0]).toMatchObject({ cadence: "weekly", weekdays: [1] });
    expect(H.state.inserts[1]).toMatchObject({
      scheduledAt: new Date("2026-10-26T06:00:00.000Z"),
      sourceScheduleId: SCHED,
    });
  });

  it("rejects weekly cadence without weekdays", async () => {
    expect(
      await upsertRebootSchedule({
        ...dailyInput,
        cadence: "weekly",
        weekdays: [],
      }),
    ).toEqual({ ok: false, reason: "bad-input" });
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid local time", async () => {
    expect(
      await upsertRebootSchedule({ ...dailyInput, localTime: "25:99" }),
    ).toEqual({ ok: false, reason: "bad-input" });
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid timezone", async () => {
    expect(
      await upsertRebootSchedule({ ...dailyInput, timezone: "Not/AZone" }),
    ).toEqual({ ok: false, reason: "bad-input" });
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("rejects a blank target ip", async () => {
    expect(
      await upsertRebootSchedule({ ...dailyInput, targetIp: "   " }),
    ).toEqual({ ok: false, reason: "bad-input" });
    expect(H.insertMock).not.toHaveBeenCalled();
  });
});

describe("materializeRebootSchedule", () => {
  it("skips a second call while a reboot is in flight", async () => {
    const row = scheduleRow();
    H.state.selects = [
      [row],
      [],
      [{ ip: "192.168.70.5" }],
      [],
      [row],
      [{ id: JOB }],
    ];
    H.state.insertReturns = [[{ id: JOB }]];

    expect(await materializeRebootSchedule(SCHED)).toBe("created");
    expect(await materializeRebootSchedule(SCHED)).toBe("skipped");
    expect(H.state.inserts).toHaveLength(1);
    expect(H.state.inserts[0]).toMatchObject({
      sourceScheduleId: SCHED,
      targetIp: "192.168.70.5",
    });
  });

  it("returns notfound when the schedule is missing", async () => {
    H.state.selects = [[]];
    expect(await materializeRebootSchedule(SCHED)).toBe("notfound");
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("returns disabled without enqueueing", async () => {
    H.state.selects = [[scheduleRow({ enabled: false })]];
    expect(await materializeRebootSchedule(SCHED)).toBe("disabled");
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("skips when the computer has no ip", async () => {
    H.state.selects = [[scheduleRow()], [], []];
    expect(await materializeRebootSchedule(SCHED)).toBe("skipped");
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("skips when enqueue finds an in-flight reboot", async () => {
    H.state.selects = [[scheduleRow()], [], [{ ip: "192.168.70.5" }], [{ id: JOB }]];
    expect(await materializeRebootSchedule(SCHED)).toBe("skipped");
    expect(H.insertMock).not.toHaveBeenCalled();
    expect(H.state.updateSets).toEqual([]);
  });
});

describe("setRebootScheduleEnabled", () => {
  it("disable cancels the in-flight child and clears nextJobId", async () => {
    H.state.updateReturns = [[{ id: SCHED, nextJobId: JOB }], [canceledRow(JOB)]];
    H.state.selects = [[{ id: JOB }]];

    expect(await setRebootScheduleEnabled(ASSET, false)).toBe(true);
    expect(H.state.updateSets[0]).toMatchObject({ enabled: false });
    expect(H.state.updateSets[1]).toMatchObject({ status: "canceled" });
    expect(H.state.updateSets[2]).toMatchObject({ nextJobId: null });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB, status: "canceled" }),
    );
  });

  it("enable books the next job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T14:00:00.000Z"));
    H.state.updateReturns = [[{ id: SCHED, nextJobId: null }]];
    H.state.selects = [[scheduleRow()], [], [{ ip: "192.168.70.5" }], []];
    H.state.insertReturns = [[{ id: JOB }]];

    expect(await setRebootScheduleEnabled(ASSET, true)).toBe(true);
    expect(H.state.updateSets[0]).toMatchObject({ enabled: true });
    expect(H.state.inserts[0]).toMatchObject({
      sourceScheduleId: SCHED,
      scheduledAt: new Date("2026-10-23T19:30:00.000Z"),
    });
    expect(H.state.updateSets.at(-1)).toMatchObject({ nextJobId: JOB });
  });

  it("returns false when the asset has no schedule", async () => {
    H.state.updateReturns = [[]];
    expect(await setRebootScheduleEnabled(ASSET, true)).toBe(false);
    expect(H.insertMock).not.toHaveBeenCalled();
  });
});

describe("deleteRebootSchedule", () => {
  it("cancels the child and removes the schedule", async () => {
    H.state.selects = [[{ id: SCHED, nextJobId: JOB }], [{ id: JOB }]];
    H.state.updateReturns = [[canceledRow(JOB)]];
    H.state.deleteReturns = [[{ id: SCHED }]];

    expect(await deleteRebootSchedule(ASSET)).toBe(true);
    expect(H.state.updateSets[0]).toMatchObject({ status: "canceled" });
    expect(H.deleteMock).toHaveBeenCalled();
  });

  it("returns false when no schedule exists", async () => {
    H.state.selects = [[]];
    expect(await deleteRebootSchedule(ASSET)).toBe(false);
    expect(H.deleteMock).not.toHaveBeenCalled();
  });
});

describe("getRebootScheduleForAssetTag", () => {
  it("returns the schedule and the next run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T14:00:00.000Z"));
    H.state.selects = [
      [
        {
          id: SCHED,
          assetId: ASSET,
          cadence: "daily",
          weekdays: null,
          localTime: "15:30",
          timezone: "America/New_York",
          enabled: true,
          requestedBy: "ada",
          nextJobId: JOB,
        },
      ],
    ];

    expect(await getRebootScheduleForAssetTag("PC-1")).toEqual({
      id: SCHED,
      assetId: ASSET,
      cadence: "daily",
      weekdays: null,
      localTime: "15:30",
      timezone: "America/New_York",
      enabled: true,
      requestedBy: "ada",
      nextJobId: JOB,
      nextRunAtIso: "2026-10-23T19:30:00.000Z",
    });
  });

  it("returns null when the tag has no schedule", async () => {
    H.state.selects = [[]];
    expect(await getRebootScheduleForAssetTag("missing")).toBeNull();
  });

  it("omits the next run when the schedule is disabled", async () => {
    H.state.selects = [
      [
        {
          id: SCHED,
          assetId: ASSET,
          cadence: "daily",
          weekdays: null,
          localTime: "15:30",
          timezone: "America/New_York",
          enabled: false,
          requestedBy: "ada",
          nextJobId: null,
        },
      ],
    ];
    const item = await getRebootScheduleForAssetTag("PC-1");
    expect(item?.enabled).toBe(false);
    expect(item?.nextRunAtIso).toBeNull();
  });
});

describe("materializeDueRebootSchedules", () => {
  it("materializes enabled schedules that have no in-flight child", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T14:00:00.000Z"));
    H.state.selects = [
      [{ id: SCHED }],
      [scheduleRow()],
      [],
      [{ ip: "192.168.70.5" }],
      [],
    ];
    H.state.insertReturns = [[{ id: JOB }]];

    expect(await materializeDueRebootSchedules()).toEqual({
      checked: 1,
      created: 1,
    });
    expect(H.state.inserts[0]).toMatchObject({ sourceScheduleId: SCHED });
  });

  it("reports zero when nothing is due", async () => {
    H.state.selects = [[]];
    expect(await materializeDueRebootSchedules()).toEqual({
      checked: 0,
      created: 0,
    });
  });
});

describe("onScheduleJobTerminal", () => {
  it("clears a matching nextJobId and materializes the following occurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T14:00:00.000Z"));
    H.state.selects = [
      [{ id: JOB, sourceScheduleId: SCHED }],
      [scheduleRow()],
      [],
      [{ ip: "192.168.70.5" }],
      [],
    ];
    H.state.insertReturns = [[{ id: NEXT }]];

    await onScheduleJobTerminal(JOB);

    expect(H.state.updateSets[0]).toMatchObject({ nextJobId: null });
    expect(H.state.updateSets[1]).toMatchObject({ nextJobId: NEXT });
    expect(H.state.inserts[0]).toMatchObject({ sourceScheduleId: SCHED });
  });

  it("does nothing when the job is not from a schedule", async () => {
    H.state.selects = [[{ id: JOB, sourceScheduleId: null }]];
    await onScheduleJobTerminal(JOB);
    expect(H.updateMock).not.toHaveBeenCalled();
    expect(H.insertMock).not.toHaveBeenCalled();
  });
});
