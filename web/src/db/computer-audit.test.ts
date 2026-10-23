import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the computer audit write/read helpers (spec 26).
 * The DB client is mocked the same way as reboot-schedules.test.ts.
 */

const H = vi.hoisted(() => {
  const state: {
    selects: unknown[][];
    insertReturns: unknown[][];
    inserts: unknown[];
    insertError: unknown;
    updateReturns: unknown[][];
    updateSets: Record<string, unknown>[];
    updateError: unknown;
    conflictSets: Record<string, unknown>[];
    conflictTargets: unknown[];
    wheres: unknown[];
    limits: number[];
    offsets: number[];
  } = {
    selects: [],
    insertReturns: [],
    inserts: [],
    insertError: null,
    updateReturns: [],
    updateSets: [],
    updateError: null,
    conflictSets: [],
    conflictTargets: [],
    wheres: [],
    limits: [],
    offsets: [],
  };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "leftJoin", "innerJoin", "groupBy"]) b[m] = self;
    b.where = (clause: unknown) => {
      state.wheres.push(clause);
      return b;
    };
    b.orderBy = self;
    b.limit = (n: number) => {
      state.limits.push(n);
      return b;
    };
    b.offset = (n: number) => {
      state.offsets.push(n);
      return b;
    };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selects.shift() ?? []).then(res, rej);
    return b;
  };
  const selectMock = vi.fn(() => makeSelect());

  const insertMock = vi.fn(() => ({
    values: (vals: unknown) => {
      state.inserts.push(vals);
      const returning = () => {
        if (state.insertError) return Promise.reject(state.insertError);
        return Promise.resolve(state.insertReturns.shift() ?? []);
      };
      return {
        returning,
        onConflictDoUpdate: (cfg: { target: unknown; set: Record<string, unknown> }) => {
          state.conflictTargets.push(cfg.target);
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
          p.returning = () => {
            if (state.updateError) return Promise.reject(state.updateError);
            return Promise.resolve(state.updateReturns.shift() ?? []);
          };
          return p;
        },
      };
    },
  }));

  return { state, selectMock, insertMock, updateMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
  },
}));

import { computerAuditEvents } from "./schema";
import {
  getAuditKpis,
  listAuditEvents,
  updateAuditEventStatus,
  upsertAuditEvent,
} from "./computer-audit";

const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-10-23T16:00:00.000Z");
const DEFAULT_FROM = new Date("2026-09-23T16:00:00.000Z");

function datesIn(root: unknown): Date[] {
  const found: Date[] = [];
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur instanceof Date) {
      found.push(cur);
      continue;
    }
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    for (const value of Object.values(cur)) stack.push(value);
  }
  return found;
}

function whereIsos(): string[] {
  return H.state.wheres.flatMap(datesIn).map((d) => d.toISOString());
}

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.inserts = [];
  H.state.insertError = null;
  H.state.updateReturns = [];
  H.state.updateSets = [];
  H.state.updateError = null;
  H.state.conflictSets = [];
  H.state.conflictTargets = [];
  H.state.wheres = [];
  H.state.limits = [];
  H.state.offsets = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("upsertAuditEvent", () => {
  it("inserts sourceTable, sourceId, and the event fields", async () => {
    H.state.insertReturns = [[{ id: EVENT }]];

    await expect(
      upsertAuditEvent({
        sourceTable: "software_deployments",
        sourceId: SOURCE,
        assetId: ASSET,
        action: "software_deploy",
        operator: "ada@h2tecs.local",
        source: "admin_console",
        summary: "Installed Chrome 120",
        details: { packageName: "Chrome" },
      }),
    ).resolves.toEqual({ ok: true, id: EVENT });

    expect(H.state.inserts[0]).toMatchObject({
      sourceTable: "software_deployments",
      sourceId: SOURCE,
      assetId: ASSET,
      action: "software_deploy",
      operator: "ada@h2tecs.local",
      source: "admin_console",
      summary: "Installed Chrome 120",
      details: { packageName: "Chrome" },
      status: "pending",
    });
    expect(H.state.inserts[0]).not.toHaveProperty("occurredAt");
    expect(H.state.conflictTargets[0]).toEqual([
      computerAuditEvents.sourceTable,
      computerAuditEvents.sourceId,
    ]);
  });

  it("does not overwrite occurredAt on conflict", async () => {
    H.state.insertReturns = [[{ id: EVENT }]];
    const occurredAt = new Date("2026-10-01T12:00:00.000Z");

    await upsertAuditEvent({
      sourceTable: "reboot_jobs",
      sourceId: SOURCE,
      assetId: ASSET,
      action: "reboot",
      operator: "system",
      source: "scheduled",
      summary: "Forced reboot",
      details: { scheduleId: "sched-1" },
      status: "succeeded",
      occurredAt,
    });

    expect(H.state.inserts[0]).toMatchObject({ occurredAt });
    const set = H.state.conflictSets[0];
    expect(set).toMatchObject({
      assetId: ASSET,
      action: "reboot",
      operator: "system",
      source: "scheduled",
      summary: "Forced reboot",
      details: { scheduleId: "sched-1" },
      status: "succeeded",
    });
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty("occurredAt");
    expect(set).not.toHaveProperty("flagged");
  });

  it("returns ok false when the insert throws", async () => {
    H.state.insertError = new Error("db down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        upsertAuditEvent({
          sourceTable: "software_deployments",
          sourceId: SOURCE,
          assetId: ASSET,
          action: "software_deploy",
          operator: "ada@h2tecs.local",
          source: "admin_console",
          summary: "Installed Chrome 120",
        }),
      ).resolves.toEqual({ ok: false });

      expect(spy).toHaveBeenCalledWith("[audit]", expect.any(Error));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("updateAuditEventStatus", () => {
  it("returns true and patches status without occurredAt", async () => {
    H.state.updateReturns = [[{ id: EVENT }]];

    await expect(
      updateAuditEventStatus({
        sourceTable: "reboot_jobs",
        sourceId: SOURCE,
        status: "succeeded",
        summary: "Forced reboot",
        details: { ok: true },
      }),
    ).resolves.toBe(true);

    const set = H.state.updateSets[0];
    expect(set).toMatchObject({
      status: "succeeded",
      summary: "Forced reboot",
      details: { ok: true },
    });
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty("occurredAt");
  });

  it("omits summary and details when they are not passed", async () => {
    H.state.updateReturns = [[{ id: EVENT }]];

    await updateAuditEventStatus({
      sourceTable: "reboot_jobs",
      sourceId: SOURCE,
      status: "failed",
    });

    expect(H.state.updateSets[0]).not.toHaveProperty("summary");
    expect(H.state.updateSets[0]).not.toHaveProperty("details");
    expect(H.state.updateSets[0]).not.toHaveProperty("occurredAt");
  });

  it("returns false when no row is updated", async () => {
    H.state.updateReturns = [[]];

    await expect(
      updateAuditEventStatus({
        sourceTable: "reboot_jobs",
        sourceId: SOURCE,
        status: "canceled",
      }),
    ).resolves.toBe(false);
  });

  it("returns false when the update throws", async () => {
    H.state.updateError = new Error("db down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        updateAuditEventStatus({
          sourceTable: "reboot_jobs",
          sourceId: SOURCE,
          status: "failed",
        }),
      ).resolves.toBe(false);

      expect(spy).toHaveBeenCalledWith("[audit]", expect.any(Error));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listAuditEvents", () => {
  it("maps joined rows to audit list items", async () => {
    const occurredAt = new Date("2026-10-20T12:00:00.000Z");
    H.state.selects = [
      [
        {
          id: EVENT,
          occurredAt,
          assetTag: "H2TECS-COMP-7491",
          assetName: "Front Desk",
          serial: null,
          action: "reboot",
          status: "succeeded",
          operator: "ada@h2tecs.local",
          source: "admin_console",
          summary: "Forced reboot",
          flagged: true,
          details: { reason: "patch" },
        },
      ],
    ];

    await expect(
      listAuditEvents({
        assetId: ASSET,
        from: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual([
      {
        id: EVENT,
        occurredAtIso: "2026-10-20T12:00:00.000Z",
        assetTag: "H2TECS-COMP-7491",
        assetName: "Front Desk",
        serial: null,
        action: "reboot",
        status: "succeeded",
        operator: "ada@h2tecs.local",
        source: "admin_console",
        summary: "Forced reboot",
        flagged: true,
        details: { reason: "patch" },
      },
    ]);
  });

  it("defaults from to 30 days ago", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    H.state.selects = [[]];

    await listAuditEvents({});

    expect(whereIsos()).toContain(DEFAULT_FROM.toISOString());
  });

  it("uses an explicit from instead of the 30 day default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    H.state.selects = [[]];

    await listAuditEvents({ from: new Date("2026-01-15T00:00:00.000Z") });

    const isos = whereIsos();
    expect(isos).toContain("2026-01-15T00:00:00.000Z");
    expect(isos).not.toContain(DEFAULT_FROM.toISOString());
  });

  it("applies limit and offset when provided", async () => {
    H.state.selects = [[]];

    await listAuditEvents({
      from: new Date("2026-10-01T00:00:00.000Z"),
      limit: 25,
      offset: 50,
    });

    expect(H.state.limits).toEqual([25]);
    expect(H.state.offsets).toEqual([50]);
  });
});

describe("getAuditKpis", () => {
  it("maps aggregate counts to numbers", async () => {
    H.state.selects = [
      [{ total: "4", today: "1", uniqueOperators: "2", flagged: "3" }],
    ];

    await expect(
      getAuditKpis({
        from: new Date("2026-10-01T00:00:00.000Z"),
        to: new Date("2026-10-23T00:00:00.000Z"),
        locationId: LOC,
      }),
    ).resolves.toEqual({
      total: 4,
      today: 1,
      uniqueOperators: 2,
      flagged: 3,
    });
  });

  it("returns zeros when the aggregate row is missing", async () => {
    H.state.selects = [[]];

    await expect(
      getAuditKpis({ from: new Date("2026-10-01T00:00:00.000Z") }),
    ).resolves.toEqual({
      total: 0,
      today: 0,
      uniqueOperators: 0,
      flagged: 0,
    });
  });

  it("defaults the KPI window to 30 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    H.state.selects = [[]];

    await getAuditKpis({});

    expect(whereIsos()).toContain(DEFAULT_FROM.toISOString());
  });
});
