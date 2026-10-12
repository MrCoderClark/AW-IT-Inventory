import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the Remote Actions session helpers (spec 24). The DB client is
 * the boundary and is mocked; the logic under test is the create guards (Computer
 * + IP + one-open-per-target), ownership/status gating, the claim fence, and the
 * append/read cursor shaping. Traces:
 *   AC-2  createRemoteSession target guards (not-computer / no-ip)
 *   AC-5  ownership checks (appendInput, requestEndSession)
 *   AC-6  requestEndSession transitions (pending→canceled, active→closing)
 *   AC-9  one-open-per-target → already-open
 *   AC-3  fenced status (markSessionActive / finishSession stale vs notfound)
 */

const H = vi.hoisted(() => {
  const state: {
    selects: unknown[][]; // one entry per awaited select, in call order
    insertReturns: unknown[][];
    updateReturns: unknown[][];
    updateSets: Record<string, unknown>[]; // captured update .set() payloads
    eventInserts: unknown[]; // captured event-log inserts
    insertError: boolean; // make the session insert raise 23505
    execResult: unknown[];
  } = {
    selects: [],
    insertReturns: [],
    updateReturns: [],
    updateSets: [],
    eventInserts: [],
    insertError: false,
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
    values: (rows: unknown) => {
      // event-log inserts (array of rows) are captured; session insert may error.
      // Return a thenable OBJECT (not a Promise instance) so an unconsumed branch
      // never produces an unhandled rejection that would crash the worker.
      if (Array.isArray(rows)) state.eventInserts.push(...rows);
      const err = state.insertError ? { code: "23505" } : null;
      return {
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          (err ? Promise.reject(err) : Promise.resolve()).then(res, rej),
        returning: () =>
          err
            ? Promise.reject(err)
            : Promise.resolve(state.insertReturns.shift() ?? []),
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
    where: () => ({ returning: () => Promise.resolve([]) }),
  }));

  const executeMock = vi.fn(() => Promise.resolve(state.execResult));

  const tx = {
    execute: executeMock,
    select: selectMock,
    insert: insertMock,
  };
  const transactionMock = vi.fn((cb: (t: unknown) => unknown) => cb(tx));

  return {
    state,
    selectMock,
    insertMock,
    updateMock,
    deleteMock,
    executeMock,
    transactionMock,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
    delete: H.deleteMock,
    execute: H.executeMock,
    transaction: H.transactionMock,
  },
}));

import {
  createRemoteSession,
  requestEndSession,
  appendInput,
  markSessionActive,
  finishSession,
  readEventsAfter,
} from "./remote-sessions";

const SID = "0959927f-1046-4582-9a70-60a4175f206b";
const FENCE = { workerId: "w1", claimedAt: "2026-10-09T10:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.updateReturns = [];
  H.state.updateSets = [];
  H.state.eventInserts = [];
  H.state.insertError = false;
  H.state.execResult = [];
});

describe("createRemoteSession — target guards (AC-2, AC-9)", () => {
  it("refuses an unknown asset", async () => {
    H.state.selects = [[]];
    expect(await createRemoteSession({ assetTag: "NOPE", requestedBy: "me" })).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("refuses a non-Computer asset", async () => {
    H.state.selects = [[{ assetId: "a1", type: "Printer", ip: "1.2.3.4" }]];
    expect(await createRemoteSession({ assetTag: "PRN", requestedBy: "me" })).toMatchObject({
      reason: "not-computer",
    });
  });

  it("refuses a Computer with no IP", async () => {
    H.state.selects = [[{ assetId: "a1", type: "Computer", ip: null }]];
    expect(await createRemoteSession({ assetTag: "PC", requestedBy: "me" })).toMatchObject({
      reason: "no-ip",
    });
  });

  it("creates a pending session for a Computer with an IP", async () => {
    H.state.selects = [[{ assetId: "a1", type: "Computer", ip: "192.168.70.5" }]];
    H.state.insertReturns = [[{ id: SID }]];
    expect(await createRemoteSession({ assetTag: "PC", requestedBy: "me" })).toEqual({
      ok: true,
      sessionId: SID,
    });
  });

  it("maps a one-open-per-target race (23505) to already-open", async () => {
    H.state.selects = [[{ assetId: "a1", type: "Computer", ip: "192.168.70.5" }]];
    H.state.insertError = true;
    expect(await createRemoteSession({ assetTag: "PC", requestedBy: "me" })).toMatchObject({
      reason: "already-open",
    });
  });
});

describe("requestEndSession — ownership + transitions (AC-5, AC-6)", () => {
  it("returns notfound for an unknown session", async () => {
    H.state.selects = [[]];
    expect(await requestEndSession(SID, "me")).toBe("notfound");
  });

  it("refuses a non-owner", async () => {
    H.state.selects = [[{ id: SID, requestedBy: "someone-else", status: "active" }]];
    expect(await requestEndSession(SID, "me")).toBe("forbidden");
  });

  it("cancels a still-pending session outright", async () => {
    H.state.selects = [[{ id: SID, requestedBy: "me", status: "pending" }]];
    expect(await requestEndSession(SID, "me")).toBe("ok");
    expect(H.state.updateSets[0]).toMatchObject({ status: "canceled" });
  });

  it("moves an active session to closing", async () => {
    H.state.selects = [[{ id: SID, requestedBy: "me", status: "active" }]];
    expect(await requestEndSession(SID, "me")).toBe("ok");
    expect(H.state.updateSets[0]).toMatchObject({ status: "closing" });
  });
});

describe("appendInput — ownership + active gate (AC-5)", () => {
  it("refuses a non-owner", async () => {
    H.state.selects = [[{ id: SID, requestedBy: "other", status: "active" }]];
    expect(await appendInput(SID, "me", "whoami")).toEqual({ outcome: "forbidden" });
  });

  it("refuses input to a non-active session", async () => {
    H.state.selects = [[{ id: SID, requestedBy: "me", status: "closed" }]];
    expect(await appendInput(SID, "me", "whoami")).toEqual({ outcome: "not-active" });
  });

  it("appends an input line and returns its seq for the owner", async () => {
    H.state.selects = [
      [{ id: SID, requestedBy: "me", status: "active" }], // getRemoteSession
      [{ max: 4 }], // appendEvents agg
    ];
    const res = await appendInput(SID, "me", "whoami");
    expect(res).toEqual({ outcome: "ok", seq: 5 });
    expect(H.state.eventInserts[0]).toMatchObject({
      direction: "input",
      data: "whoami",
      seq: 5,
    });
  });
});

describe("fenced status (AC-3)", () => {
  it("markSessionActive is stale when the row exists but the claim lost", async () => {
    H.state.updateReturns = [[]]; // fenced update affected nothing
    H.state.selects = [[{ id: SID, status: "active" }]]; // row still exists
    expect(await markSessionActive(SID, FENCE)).toBe("stale");
  });

  it("finishSession is notfound when no row matches at all", async () => {
    H.state.updateReturns = [[]];
    H.state.selects = [[]];
    expect(await finishSession(SID, FENCE, "closed")).toBe("notfound");
  });

  it("finishSession is ok when the fenced update applies", async () => {
    H.state.updateReturns = [[{ id: SID }]];
    expect(await finishSession(SID, FENCE, "failed", "boom")).toBe("ok");
    expect(H.state.updateSets[0]).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("readEventsAfter — guards", () => {
  it("returns [] for a malformed id or no directions without querying", async () => {
    expect(await readEventsAfter("nope", 0, ["output"])).toEqual([]);
    expect(await readEventsAfter(SID, 0, [])).toEqual([]);
    expect(H.selectMock).not.toHaveBeenCalled();
  });
});
