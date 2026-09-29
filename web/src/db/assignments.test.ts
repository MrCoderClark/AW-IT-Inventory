import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the assignment engine (spec 16). The transaction-aware cores
 * (`assignAssetTx` / `returnAssetTx`) are exercised against a fake transaction so
 * the real logic under test is the open-close-sync sequence and the single-open
 * invariant; the read helpers are tested against the mocked DB client. Traces:
 *   AC-5 assign opens a new row and closes the prior; no churn for the same holder
 *   AC-6 return closes the open assignment and clears assigneeId
 *   AC-8 an archived person is refused as an assignee
 *   AC-11 assigneeId is written together with the assignment, only by the engine
 *   AC-4 / AC-7 history read shaping (open flag, tag mapping, current devices)
 */

const H = vi.hoisted(() => {
  const state: { selectResults: unknown[][] } = { selectResults: [] };
  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"]) {
      b[m] = self;
    }
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResults.shift() ?? []).then(res, rej);
    return b;
  };
  return { state, select: vi.fn(() => makeSelect()), transaction: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: { select: H.select, transaction: H.transaction },
}));

import {
  assignAsset,
  assignAssetTx,
  isOpenAssignmentRace,
  returnAssetTx,
  getAssetAssignmentHistory,
  getPersonAssignments,
} from "./assignments";

const ASSET = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

/**
 * A fake transaction with the same query surface the engine uses. `selects` is a
 * queue consumed in order; `updateReturnings` feeds `.returning()` on updates.
 * Captures the insert payloads and the `set()` values for assertions.
 */
function makeTx() {
  const selects: unknown[][] = [];
  const updateReturnings: unknown[][] = [];
  const captured = { inserts: [] as unknown[], sets: [] as Record<string, unknown>[] };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "where", "limit"]) b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(selects.shift() ?? []).then(res, rej);
    return b;
  };
  const makeWhere = () => {
    const p = Promise.resolve(undefined) as Promise<unknown> & {
      returning?: () => Promise<unknown>;
    };
    p.returning = () => Promise.resolve(updateReturnings.shift() ?? []);
    return p;
  };
  const tx = {
    select: () => makeSelect(),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured.sets.push(v);
        return { where: () => makeWhere() };
      },
    }),
    insert: () => ({
      values: (rows: unknown) => {
        captured.inserts.push(rows);
        return Promise.resolve();
      },
    }),
  };
  return { tx, selects, updateReturnings, captured };
}

beforeEach(() => {
  H.state.selectResults = [];
  vi.clearAllMocks();
});

describe("assignAssetTx (AC-5, AC-11)", () => {
  it("opens a new assignment and sets assigneeId when the device is free", async () => {
    const { tx, selects, captured } = makeTx();
    selects.push([{ id: ASSET }]); // asset exists
    selects.push([{ id: PERSON, status: "active" }]); // person active
    selects.push([]); // no open assignment

    const res = await assignAssetTx(tx as never, ASSET, PERSON, "admin@x");
    expect(res).toEqual({ ok: true });
    // A new open row was inserted, stamped by the actor.
    expect(captured.inserts[0]).toMatchObject({
      assetId: ASSET,
      personId: PERSON,
      assignedBy: "admin@x",
    });
    // assigneeId was synced to the same person, in the same transaction (AC-11).
    expect(captured.sets.some((s) => s.assigneeId === PERSON)).toBe(true);
  });

  it("closes the prior assignment and opens exactly one new one on reassign (AC-5)", async () => {
    const { tx, selects, captured } = makeTx();
    selects.push([{ id: ASSET }]);
    selects.push([{ id: PERSON, status: "active" }]);
    selects.push([{ id: "open-1", personId: OTHER }]); // held by someone else

    const res = await assignAssetTx(tx as never, ASSET, PERSON, "admin@x");
    expect(res).toEqual({ ok: true });
    // Exactly one new open row, and a close happened (an unassignedAt set).
    expect(captured.inserts).toHaveLength(1);
    expect(captured.sets.some((s) => "unassignedAt" in s)).toBe(true);
  });

  it("is a no-op when the same person already holds it (no log churn)", async () => {
    const { tx, selects, captured } = makeTx();
    selects.push([{ id: ASSET }]);
    selects.push([{ id: PERSON, status: "active" }]);
    selects.push([{ id: "open-1", personId: PERSON }]); // already this person

    const res = await assignAssetTx(tx as never, ASSET, PERSON, "admin@x");
    expect(res).toEqual({ ok: true });
    expect(captured.inserts).toHaveLength(0);
    expect(captured.sets).toHaveLength(0);
  });

  it("refuses an archived person (AC-8)", async () => {
    const { tx, selects, captured } = makeTx();
    selects.push([{ id: ASSET }]);
    selects.push([{ id: PERSON, status: "archived" }]);

    const res = await assignAssetTx(tx as never, ASSET, PERSON, "admin@x");
    expect(res).toEqual({ ok: false, error: "person-archived" });
    expect(captured.inserts).toHaveLength(0);
  });

  it("reports asset-not-found and person-not-found", async () => {
    const a = makeTx();
    a.selects.push([]); // asset missing
    expect(await assignAssetTx(a.tx as never, ASSET, PERSON, "x")).toEqual({
      ok: false,
      error: "asset-not-found",
    });

    const b = makeTx();
    b.selects.push([{ id: ASSET }]);
    b.selects.push([]); // person missing
    expect(await assignAssetTx(b.tx as never, ASSET, PERSON, "x")).toEqual({
      ok: false,
      error: "person-not-found",
    });
  });

  it("guards malformed ids before any query", async () => {
    const { tx, captured } = makeTx();
    expect(await assignAssetTx(tx as never, "bad", PERSON, "x")).toEqual({
      ok: false,
      error: "asset-not-found",
    });
    expect(captured.inserts).toHaveLength(0);
  });
});

describe("assignAsset — the lost double-assign race (AC-5, AC-11)", () => {
  const race = Object.assign(new Error("dup"), {
    code: "23505",
    constraint_name: "asset_assignments_open_uq",
  });

  it("recognises a 23505 on the open-assignment index", () => {
    expect(isOpenAssignmentRace(race)).toBe(true);
    // A different unique index, or a non-unique error, is not this race.
    expect(isOpenAssignmentRace({ code: "23505", constraint_name: "people_email_lower_uq" })).toBe(false);
    expect(isOpenAssignmentRace({ code: "23503" })).toBe(false);
    expect(isOpenAssignmentRace(null)).toBe(false);
  });

  it("turns the race into a clean already-assigned result, not a raw throw", async () => {
    H.transaction.mockRejectedValue(race);
    const res = await assignAsset(ASSET, PERSON, "admin@x");
    expect(res).toEqual({ ok: false, error: "already-assigned" });
  });

  it("passes an ok result straight through", async () => {
    H.transaction.mockResolvedValue({ ok: true });
    expect(await assignAsset(ASSET, PERSON, "admin@x")).toEqual({ ok: true });
  });

  it("rethrows an unrelated transaction failure", async () => {
    H.transaction.mockRejectedValue(new Error("connection lost"));
    await expect(assignAsset(ASSET, PERSON, "admin@x")).rejects.toThrow("connection lost");
  });
});

describe("returnAssetTx (AC-6, AC-11)", () => {
  it("closes the open assignment and clears assigneeId", async () => {
    const { tx, updateReturnings, captured } = makeTx();
    updateReturnings.push([{ id: "open-1" }]); // one row closed

    const res = await returnAssetTx(tx as never, ASSET, "admin@x");
    expect(res).toEqual({ ok: true, changed: true });
    // The close stamped the actor, and assigneeId was cleared.
    expect(captured.sets.some((s) => s.unassignedBy === "admin@x")).toBe(true);
    expect(captured.sets.some((s) => s.assigneeId === null)).toBe(true);
  });

  it("reports no change but still clears assigneeId when nothing was open", async () => {
    const { tx, updateReturnings, captured } = makeTx();
    updateReturnings.push([]); // nothing to close

    const res = await returnAssetTx(tx as never, ASSET, "admin@x");
    expect(res).toEqual({ ok: true, changed: false });
    expect(captured.sets.some((s) => s.assigneeId === null)).toBe(true);
  });

  it("no-ops for a malformed asset id", async () => {
    const { tx, captured } = makeTx();
    const res = await returnAssetTx(tx as never, "bad", "admin@x");
    expect(res).toEqual({ ok: true, changed: false });
    expect(captured.sets).toHaveLength(0);
  });
});

describe("getAssetAssignmentHistory (AC-7)", () => {
  it("maps rows to events, flagging the open one and using the tag as the link id", async () => {
    H.state.selectResults = [
      [
        {
          id: "e1",
          assetTag: "OPUS-PHN-7495",
          assetName: "Field iPhone",
          assetType: "Phone",
          personId: PERSON,
          personName: "Verify Person",
          assignedAt: new Date("2026-09-29T15:14:00Z"),
          assignedBy: "admin@x",
          unassignedAt: null,
          unassignedBy: null,
        },
        {
          id: "e2",
          assetTag: "OPUS-PHN-7495",
          assetName: "Field iPhone",
          assetType: "Phone",
          personId: PERSON,
          personName: "Verify Person",
          assignedAt: new Date("2026-09-29T15:12:00Z"),
          assignedBy: "admin@x",
          unassignedAt: new Date("2026-09-29T15:13:00Z"),
          unassignedBy: "admin@x",
        },
      ],
    ];
    const events = await getAssetAssignmentHistory("OPUS-PHN-7495");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: "e1", assetId: "OPUS-PHN-7495", open: true });
    expect(events[1]).toMatchObject({ open: false, unassignedBy: "admin@x" });
  });
});

describe("getPersonAssignments (AC-4)", () => {
  it("returns current devices (open only) plus the full history", async () => {
    H.state.selectResults = [
      [
        {
          id: "e1",
          assetTag: "OPUS-COMP-1",
          assetName: "Laptop",
          assetType: "Computer",
          assetSerial: "SN-1",
          personId: PERSON,
          personName: "P",
          assignedAt: new Date("2026-09-29T10:00:00Z"),
          assignedBy: "admin@x",
          unassignedAt: null,
          unassignedBy: null,
        },
        {
          id: "e2",
          assetTag: "OPUS-COMP-2",
          assetName: "Old Laptop",
          assetType: "Computer",
          assetSerial: "SN-2",
          personId: PERSON,
          personName: "P",
          assignedAt: new Date("2026-09-01T10:00:00Z"),
          assignedBy: "admin@x",
          unassignedAt: new Date("2026-09-15T10:00:00Z"),
          unassignedBy: "admin@x",
        },
      ],
    ];
    const { currentDevices, history } = await getPersonAssignments(PERSON);
    expect(history).toHaveLength(2);
    expect(currentDevices).toHaveLength(1);
    expect(currentDevices[0]).toMatchObject({ id: "OPUS-COMP-1", serial: "SN-1" });
  });

  it("returns empties for a malformed person id", async () => {
    const res = await getPersonAssignments("bad");
    expect(res).toEqual({ currentDevices: [], history: [] });
  });
});
