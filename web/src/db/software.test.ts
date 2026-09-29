import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the software-inventory data helpers (spec 15). The DB client is
 * the boundary and is mocked; the real logic under test is the watchlist match
 * (case-insensitive contains), the dedupe, the current-state replace, and the
 * read-path shaping (versions sort, per-machine grouping). Traces:
 *   AC-1 add/remove watchlist helpers (empty + duplicate + uuid guard)
 *   AC-3 replaceInstalledSoftware (contains match, one program → many titles,
 *        dedupe, empty replace clears, no watchlist stores nothing)
 *   AC-4 getSoftwareInventory (versions sorted, zero-count shape)
 *   AC-5 getSoftwareTitleDetail (uuid guard, grouping to one row per machine)
 *   AC-6 getInstalledSoftware (null fields render as empty strings)
 */

const H = vi.hoisted(() => {
  const state: {
    selectResults: unknown[][]; // one entry per awaited select, in call order
    inserted: unknown[]; // captured insert/tx-insert payloads
    insertError: (Error & { code?: string }) | null;
    deleteReturning: unknown[];
    txDeleteCalls: number;
  } = {
    selectResults: [],
    inserted: [],
    insertError: null,
    deleteReturning: [],
    txDeleteCalls: 0,
  };

  // A thenable query builder: every chain method returns itself, and awaiting it
  // (at whatever terminal the caller uses) resolves the next queued result. Each
  // select statement in the code awaits once, so results are consumed in order.
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"]) {
      b[m] = self;
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResults.shift() ?? []).then(resolve, reject);
    return b;
  };
  const selectMock = vi.fn(() => makeBuilder());

  const valuesMock = vi.fn((rows: unknown) => {
    state.inserted.push(rows);
    return state.insertError
      ? Promise.reject(state.insertError)
      : Promise.resolve();
  });
  const insertMock = vi.fn(() => ({ values: valuesMock }));

  // db.delete().where().returning() for removeTrackedSoftware; the where() result
  // is itself awaitable for the transaction's tx.delete().where().
  const deleteMock = vi.fn(() => ({
    where: () => {
      const p = Promise.resolve(state.deleteReturning) as Promise<unknown> & {
        returning?: () => Promise<unknown>;
      };
      p.returning = () => Promise.resolve(state.deleteReturning);
      return p;
    },
  }));

  const txDeleteMock = vi.fn(() => ({
    where: () => {
      state.txDeleteCalls += 1;
      return Promise.resolve();
    },
  }));
  const txInsertMock = vi.fn(() => ({
    values: (rows: unknown) => {
      state.inserted.push(rows);
      return Promise.resolve();
    },
  }));
  const transactionMock = vi.fn((cb: (tx: unknown) => unknown) =>
    cb({ delete: txDeleteMock, insert: txInsertMock }),
  );

  return { state, selectMock, insertMock, valuesMock, deleteMock, transactionMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    delete: H.deleteMock,
    transaction: H.transactionMock,
  },
}));

import {
  addTrackedSoftware,
  removeTrackedSoftware,
  replaceInstalledSoftware,
  getSoftwareInventory,
  getSoftwareTitleDetail,
  getInstalledSoftware,
} from "./software";

const UUID = "0959927f-1046-4582-9a70-60a4175f206b";

/** Pull the rows handed to the (single) insert call in this test. */
function lastInserted(): Record<string, unknown>[] {
  const last = H.state.inserted[H.state.inserted.length - 1];
  return (Array.isArray(last) ? last : last ? [last] : []) as Record<
    string,
    unknown
  >[];
}

beforeEach(() => {
  H.state.selectResults = [];
  H.state.inserted = [];
  H.state.insertError = null;
  H.state.deleteReturning = [];
  H.state.txDeleteCalls = 0;
  vi.clearAllMocks();
});

describe("replaceInstalledSoftware — watchlist match + replace (AC-3)", () => {
  it("stores only programs whose name contains a tracked title (case-insensitive)", async () => {
    H.state.selectResults = [[{ id: "t1", name: "Chrome" }]];
    const n = await replaceInstalledSoftware("asset-1", [
      { name: "Google Chrome", version: "128.0" },
      { name: "7-Zip 23.01 (x64)", version: "23.01" },
    ]);
    expect(n).toBe(1);
    const rows = lastInserted();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetId: "asset-1",
      trackedId: "t1",
      name: "Google Chrome",
      version: "128.0",
    });
  });

  it("writes a row per matched title when one program matches two titles", async () => {
    // covers: AC-3 — a program can count under more than one tracked title.
    H.state.selectResults = [
      [
        { id: "t1", name: "Office" },
        { id: "t2", name: "Microsoft 365" },
      ],
    ];
    const n = await replaceInstalledSoftware("asset-1", [
      { name: "Microsoft 365 - Office", version: "16.0" },
    ]);
    expect(n).toBe(2);
    expect(lastInserted().map((r) => r.trackedId).sort()).toEqual(["t1", "t2"]);
  });

  it("dedupes identical (title, name, version) matches", async () => {
    H.state.selectResults = [[{ id: "t1", name: "chrome" }]];
    const n = await replaceInstalledSoftware("asset-1", [
      { name: "Google Chrome", version: "1" },
      { name: "Google Chrome", version: "1" },
    ]);
    expect(n).toBe(1);
  });

  it("normalizes blank version/publisher/date to null", async () => {
    H.state.selectResults = [[{ id: "t1", name: "Chrome" }]];
    await replaceInstalledSoftware("asset-1", [
      { name: "Google Chrome", version: "  ", publisher: "", install_date: null },
    ]);
    expect(lastInserted()[0]).toMatchObject({
      version: null,
      publisher: null,
      installDate: null,
    });
  });

  it("clears the asset's rows when the scan matches nothing (empty replace)", async () => {
    H.state.selectResults = [[{ id: "t1", name: "Chrome" }]];
    const n = await replaceInstalledSoftware("asset-1", [
      { name: "Mozilla Firefox", version: "1" },
    ]);
    expect(n).toBe(0);
    expect(H.state.txDeleteCalls).toBe(1); // the delete still ran
    expect(H.state.inserted).toHaveLength(0); // nothing inserted
  });

  it("stores nothing when the watchlist is empty", async () => {
    H.state.selectResults = [[]];
    const n = await replaceInstalledSoftware("asset-1", [
      { name: "Google Chrome", version: "1" },
    ]);
    expect(n).toBe(0);
  });

  it("ignores a program with a blank name", async () => {
    H.state.selectResults = [[{ id: "t1", name: "Chrome" }]];
    const n = await replaceInstalledSoftware("asset-1", [
      { name: "   ", version: "1" },
    ]);
    expect(n).toBe(0);
  });
});

describe("addTrackedSoftware (AC-1)", () => {
  it("rejects an empty/whitespace name without touching the DB", async () => {
    expect(await addTrackedSoftware("   ")).toBe("empty");
    expect(H.selectMock).not.toHaveBeenCalled();
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("rejects a case-insensitive duplicate via the pre-check", async () => {
    H.state.selectResults = [[{ id: "existing" }]];
    expect(await addTrackedSoftware("chrome")).toBe("duplicate");
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("inserts a trimmed title on the happy path", async () => {
    H.state.selectResults = [[]]; // no existing match
    expect(await addTrackedSoftware("  Chrome  ")).toBe("ok");
    expect(H.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Chrome" }),
    );
  });

  it("maps a unique-violation race to duplicate", async () => {
    H.state.selectResults = [[]];
    H.state.insertError = Object.assign(new Error("dup"), { code: "23505" });
    expect(await addTrackedSoftware("Chrome")).toBe("duplicate");
  });

  it("rethrows a non-unique DB error", async () => {
    H.state.selectResults = [[]];
    H.state.insertError = Object.assign(new Error("boom"), { code: "08006" });
    await expect(addTrackedSoftware("Chrome")).rejects.toThrow("boom");
  });
});

describe("removeTrackedSoftware (AC-1)", () => {
  it("returns false for a malformed id without touching the DB", async () => {
    expect(await removeTrackedSoftware("not-a-uuid")).toBe(false);
    expect(H.deleteMock).not.toHaveBeenCalled();
  });

  it("returns true when a row was deleted", async () => {
    H.state.deleteReturning = [{ id: UUID }];
    expect(await removeTrackedSoftware(UUID)).toBe(true);
  });

  it("returns false when the id matched nothing", async () => {
    H.state.deleteReturning = [];
    expect(await removeTrackedSoftware(UUID)).toBe(false);
  });
});

describe("getSoftwareInventory — aggregate shape (AC-4)", () => {
  it("sorts versions numerically and passes the machine count through", async () => {
    H.state.selectResults = [
      [{ id: "t1", name: "Chrome", machineCount: 2, versions: ["2", "10", "1"] }],
    ];
    const rows = await getSoftwareInventory();
    expect(rows[0]).toEqual({
      id: "t1",
      name: "Chrome",
      machineCount: 2,
      versions: ["1", "2", "10"],
    });
  });

  it("shows a zero-count title with no versions", async () => {
    H.state.selectResults = [
      [{ id: "t2", name: "Slack", machineCount: 0, versions: null }],
    ];
    const rows = await getSoftwareInventory();
    expect(rows[0]).toMatchObject({ machineCount: 0, versions: [] });
  });
});

describe("getSoftwareTitleDetail — drill-down grouping (AC-5)", () => {
  it("returns null for a malformed id without touching the DB", async () => {
    expect(await getSoftwareTitleDetail("nope")).toBeNull();
    expect(H.selectMock).not.toHaveBeenCalled();
  });

  it("returns null when the title id is unknown", async () => {
    H.state.selectResults = [[]]; // title lookup finds nothing
    expect(await getSoftwareTitleDetail(UUID)).toBeNull();
  });

  it("collapses multiple rows per machine into one line with its versions", async () => {
    const older = new Date("2026-09-20T10:00:00Z");
    const newer = new Date("2026-09-25T10:00:00Z");
    H.state.selectResults = [
      [{ id: UUID, name: "Chrome" }], // title
      [
        { tag: "PC-A", name: "Machine A", serial: "s1", version: "1", lastSeenAt: older },
        { tag: "PC-A", name: "Machine A", serial: "s1", version: "2", lastSeenAt: newer },
        { tag: "PC-B", name: "Machine B", serial: null, version: null, lastSeenAt: newer },
      ],
    ];
    const detail = await getSoftwareTitleDetail(UUID);
    expect(detail?.title.name).toBe("Chrome");
    expect(detail?.machines).toHaveLength(2);
    const a = detail?.machines.find((m) => m.id === "PC-A");
    expect(a?.versions).toEqual(["1", "2"]);
    expect(a?.lastSeen).toBe(newer.toISOString()); // the most recent wins
    const b = detail?.machines.find((m) => m.id === "PC-B");
    expect(b).toMatchObject({ serial: "", versions: [] }); // null serial/version handled
  });
});

describe("getInstalledSoftware — detail panel (AC-6)", () => {
  it("maps null version/publisher to empty strings", async () => {
    H.state.selectResults = [
      [{ name: "Google Chrome", version: null, publisher: null }],
    ];
    const items = await getInstalledSoftware("PC-A");
    expect(items).toEqual([
      { name: "Google Chrome", version: "", publisher: "" },
    ]);
  });

  it("returns an empty list when the computer has no tracked software", async () => {
    H.state.selectResults = [[]];
    expect(await getInstalledSoftware("PC-A")).toEqual([]);
  });
});
