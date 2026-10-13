import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the connected-monitors store (spec 25). The DB client is mocked;
 * the logic under test is the replace (delete-then-insert, with the PnP vendor code
 * mapped to a name), the read mapping, and the serial reconciliation to Monitor
 * assets (phase 3) in both directions.
 */
const H = vi.hoisted(() => {
  const state: { selects: unknown[][]; inserted: unknown[][] } = {
    selects: [],
    inserted: [],
  };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"])
      b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selects.shift() ?? []).then(res, rej);
    return b;
  };
  const selectMock = vi.fn(() => makeSelect());
  const selectDistinctOnMock = vi.fn(() => makeSelect());

  const tx = {
    delete: vi.fn(() => ({ where: () => Promise.resolve() })),
    insert: vi.fn(() => ({
      values: (rows: unknown) => {
        state.inserted.push(rows as unknown[]);
        return Promise.resolve();
      },
    })),
  };
  const transactionMock = vi.fn((cb: (t: unknown) => unknown) => cb(tx));

  return { state, selectMock, selectDistinctOnMock, transactionMock, tx };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    selectDistinctOn: H.selectDistinctOnMock,
    transaction: H.transactionMock,
  },
}));

import {
  getConnectedMonitors,
  getMonitorConnection,
  replaceConnectedMonitors,
} from "./monitors";

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selects = [];
  H.state.inserted = [];
});

describe("replaceConnectedMonitors", () => {
  it("replaces the set and maps the PnP vendor code to a name", async () => {
    await replaceConnectedMonitors(
      "a1",
      [
        {
          vendor_code: "DEL",
          model: "DELL P2217H",
          serial: "ABC",
          product_code: "A0D8",
          year: 2017,
          active: true,
          diagonal_in: 21.5,
        },
      ],
      new Date("2026-10-12T00:00:00Z"),
    );
    expect(H.tx.delete).toHaveBeenCalled();
    const rows = H.state.inserted[0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetId: "a1",
      vendorCode: "DEL",
      manufacturer: "Dell", // mapped from the PnP code
      serial: "ABC",
      year: 2017,
    });
  });

  it("clears the set without inserting on an empty array", async () => {
    await replaceConnectedMonitors("a1", [], new Date());
    expect(H.tx.delete).toHaveBeenCalled();
    expect(H.state.inserted).toHaveLength(0);
  });
});

describe("getConnectedMonitors", () => {
  it("returns the stored displays with their inventory match (phase 3)", async () => {
    H.state.selects = [
      [
        {
          id: "m2",
          manufacturer: "Dell",
          model: "DELL P2217H",
          serial: "QJB",
          year: 2017,
          active: true,
          diagonalIn: 21.5,
          matchedAssetTag: null, // scanned serial OPUS doesn't track
          matchedAssetName: null,
        },
        {
          id: "m1",
          manufacturer: "Dell",
          model: "DELL P2217H",
          serial: "PWB",
          year: 2017,
          active: true,
          diagonalIn: 21.5,
          matchedAssetTag: "OPUS-MON-1",
          matchedAssetName: "Reception Monitor",
        },
      ],
    ];
    const out = await getConnectedMonitors("PC-1");
    // Sorted by model then serial; `id` is dropped from the item.
    expect(out).toEqual([
      {
        manufacturer: "Dell",
        model: "DELL P2217H",
        serial: "PWB",
        year: 2017,
        active: true,
        diagonalIn: 21.5,
        matchedAssetTag: "OPUS-MON-1",
        matchedAssetName: "Reception Monitor",
      },
      {
        manufacturer: "Dell",
        model: "DELL P2217H",
        serial: "QJB",
        year: 2017,
        active: true,
        diagonalIn: 21.5,
        matchedAssetTag: null,
        matchedAssetName: null,
      },
    ]);
  });
});

describe("getMonitorConnection", () => {
  it("returns the computer whose scan last reported the monitor's serial", async () => {
    const seenAt = new Date("2026-10-12T15:00:00Z");
    H.state.selects = [
      [{ computerTag: "PC-1", computerName: "Reception PC", seenAt }],
    ];
    const out = await getMonitorConnection("OPUS-MON-1");
    expect(out).toEqual({
      computerTag: "PC-1",
      computerName: "Reception PC",
      seenAt,
    });
  });

  it("returns null when no scan reports the monitor's serial", async () => {
    H.state.selects = [[]];
    const out = await getMonitorConnection("OPUS-MON-9");
    expect(out).toBeNull();
  });
});
