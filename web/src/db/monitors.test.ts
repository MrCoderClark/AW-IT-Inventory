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
      values: (row: unknown) => {
        state.inserted.push(Array.isArray(row) ? row : [row]);
        // Awaitable (for plain `.values(...)` inserts), and also offers the
        // onConflictDoNothing().returning() chain the asset insert uses.
        const p = Promise.resolve() as Promise<void> & {
          onConflictDoNothing?: () => { returning: () => Promise<unknown[]> };
        };
        p.onConflictDoNothing = () => ({
          returning: () =>
            Promise.resolve([{ id: "new-id", tag: "OPUS-MON-NEW" }]),
        });
        return p;
      },
    })),
  };
  const transactionMock = vi.fn((cb: (t: unknown) => unknown) => cb(tx));

  // Top-level db.insert/delete for the dismiss/restore helpers.
  const insertMock = vi.fn(() => ({
    values: (row: unknown) => {
      state.inserted.push([row]);
      return { onConflictDoNothing: () => Promise.resolve() };
    },
  }));
  const deleteMock = vi.fn(() => ({ where: () => Promise.resolve() }));

  return {
    state,
    selectMock,
    selectDistinctOnMock,
    transactionMock,
    insertMock,
    deleteMock,
    tx,
  };
});

const A = vi.hoisted(() => ({
  assignMock: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("server-only", () => ({}));
vi.mock("./assignments", () => ({ assignAssetTx: A.assignMock }));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    selectDistinctOn: H.selectDistinctOnMock,
    transaction: H.transactionMock,
    insert: H.insertMock,
    delete: H.deleteMock,
  },
}));

import {
  autoCreateExternalMonitors,
  dismissMonitor,
  getConnectedMonitors,
  getDiscoveredMonitors,
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
          resolution: "1920x1080",
          refreshHz: 60,
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
          resolution: "1920x1080",
          refreshHz: 60,
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
        resolution: "1920x1080",
        refreshHz: 60,
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
        resolution: "1920x1080",
        refreshHz: 60,
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

describe("getDiscoveredMonitors", () => {
  it("returns unmatched displays newest-first", async () => {
    const older = new Date("2026-10-10T09:00:00Z");
    const newer = new Date("2026-10-12T09:00:00Z");
    // The store sorts by seenAt desc after the DISTINCT-ON serial sort, so feed
    // them out of order to prove the sort.
    H.state.selects = [
      [
        {
          serial: "AAA",
          manufacturer: "Dell",
          vendorCode: "DEL",
          model: "DELL P2217H",
          productCode: "A0D8",
          year: 2017,
          diagonalIn: 21.5,
          computerTag: "PC-1",
          computerName: "Reception PC",
          seenAt: older,
        },
        {
          serial: "BBB",
          manufacturer: "LG",
          vendorCode: "GSM",
          model: "LG 27UL500",
          productCode: "0001",
          year: 2020,
          diagonalIn: 27,
          computerTag: "PC-2",
          computerName: "Lab PC",
          seenAt: newer,
        },
      ],
    ];
    const out = await getDiscoveredMonitors();
    expect(out.map((m) => m.serial)).toEqual(["BBB", "AAA"]);
    expect(out[0]).toMatchObject({
      serial: "BBB",
      manufacturer: "LG",
      computerName: "Lab PC",
    });
  });
});

describe("dismissMonitor", () => {
  it("inserts the trimmed serial (idempotent)", async () => {
    await dismissMonitor("  XYZ  ", "admin@corp.com");
    expect(H.insertMock).toHaveBeenCalled();
    expect(H.state.inserted[0][0]).toMatchObject({
      serial: "XYZ",
      dismissedBy: "admin@corp.com",
    });
  });

  it("no-ops on a blank serial", async () => {
    await dismissMonitor("   ", null);
    expect(H.insertMock).not.toHaveBeenCalled();
  });
});

describe("autoCreateExternalMonitors", () => {
  const extern = {
    vendor_code: "DEL",
    model: "DELL P2217H",
    serial: "EXT1",
    diagonal_in: 21.5,
    resolution: "1920x1080",
    refresh_hz: 60,
  };

  it("creates an external monitor inheriting the computer's location", async () => {
    H.state.selects = [
      [{ locationId: "loc-1" }], // computer location
      [], // no existing Monitor asset with this serial
      [], // not dismissed
    ];
    const n = await autoCreateExternalMonitors("pc-1", [extern], new Date());
    expect(n).toBe(1);
    expect(H.transactionMock).toHaveBeenCalled();
    // First insert is the asset row.
    expect(H.state.inserted[0][0]).toMatchObject({
      type: "Monitor",
      serial: "EXT1",
      vendor: "Dell",
      status: "deployed",
      locationId: "loc-1",
    });
    // Second insert is the monitor_details row with the EDID-derived fields.
    expect(H.state.inserted[1][0]).toMatchObject({
      sizeInches: "21.5",
      resolution: "1920x1080",
      refreshHz: 60,
    });
  });

  it("inherits the computer's assignee through the custody engine", async () => {
    H.state.selects = [
      [{ locationId: "loc-1", assigneeId: "person-9" }], // computer
      [], // no existing asset
      [], // not dismissed
    ];
    const n = await autoCreateExternalMonitors("pc-1", [extern], new Date());
    expect(n).toBe(1);
    expect(A.assignMock).toHaveBeenCalledWith(
      expect.anything(),
      "new-id",
      "person-9",
      "scan (auto)",
      expect.any(Date),
    );
  });

  it("leaves the monitor Available when the computer has no assignee", async () => {
    H.state.selects = [
      [{ locationId: "loc-1", assigneeId: null }], // unassigned computer
      [],
      [],
    ];
    const n = await autoCreateExternalMonitors("pc-1", [extern], new Date());
    expect(n).toBe(1);
    expect(A.assignMock).not.toHaveBeenCalled();
  });

  it("skips built-in panels entirely (no location lookup, no insert)", async () => {
    const n = await autoCreateExternalMonitors(
      "pc-1",
      [{ vendor_code: "AUO", serial: "PANEL1", model: "Internal" }],
      new Date(),
    );
    expect(n).toBe(0);
    expect(H.transactionMock).not.toHaveBeenCalled();
    expect(H.selectMock).not.toHaveBeenCalled();
  });

  it("skips a serial that is already a Monitor asset", async () => {
    H.state.selects = [
      [{ locationId: null }], // computer location
      [{ id: "existing-monitor" }], // already in inventory
    ];
    const n = await autoCreateExternalMonitors("pc-1", [extern], new Date());
    expect(n).toBe(0);
    expect(H.transactionMock).not.toHaveBeenCalled();
  });

  it("skips a dismissed serial", async () => {
    H.state.selects = [
      [{ locationId: null }], // computer location
      [], // no existing asset
      [{ serial: "EXT1" }], // dismissed
    ];
    const n = await autoCreateExternalMonitors("pc-1", [extern], new Date());
    expect(n).toBe(0);
    expect(H.transactionMock).not.toHaveBeenCalled();
  });
});
