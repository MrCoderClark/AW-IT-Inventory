import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the printer page-counter history (spec 14). The DB client and
 * the location path lookup are the boundary and are mocked; the counter math
 * (the day-over-day delta rules) runs for real. Traces:
 *   AC-2 the idempotent daily upsert (one row per printer per day, latest wins)
 *   AC-3 the detail-panel delta rules (first reading, counter reset, +N, no negative)
 *   AC-4 the report rows (every printer listed, "no reading" kept, not dropped)
 *   AC-6 the retention prune (returns the count, safe default on bad input)
 */

const H = vi.hoisted(() => {
  const state: {
    limitRows: unknown[][]; // queue for `.where().limit()` single-row lookups
    orderedRows: unknown[][]; // queue for `.where().orderBy().limit()`
    joinRows: unknown[]; // `.from().innerJoin().where()` printers list
    deleteRows: unknown[];
    upsert: { values?: Record<string, unknown>; set?: Record<string, unknown>; target?: unknown };
  } = { limitRows: [], orderedRows: [], joinRows: [], deleteRows: [], upsert: {} };

  const selectMock = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(state.limitRows.shift() ?? []),
        orderBy: () => ({
          limit: () => Promise.resolve(state.orderedRows.shift() ?? []),
        }),
      }),
      innerJoin: () => ({ where: () => Promise.resolve(state.joinRows) }),
    }),
  }));

  const insertMock = vi.fn(() => ({
    values: (values: Record<string, unknown>) => ({
      onConflictDoUpdate: (cfg: { target: unknown; set: Record<string, unknown> }) => {
        state.upsert = { values, set: cfg.set, target: cfg.target };
        return Promise.resolve();
      },
    }),
  }));

  const deleteMock = vi.fn(() => ({
    where: () => ({ returning: () => Promise.resolve(state.deleteRows) }),
  }));

  return { state, selectMock, insertMock, deleteMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/queries", () => ({ getLocationPathMap: vi.fn(async () => new Map()) }));
vi.mock("@/db/index", () => ({
  db: { select: H.selectMock, insert: H.insertMock, delete: H.deleteMock },
}));

import {
  todayLocalDate,
  upsertPrinterCounter,
  getPrinterCounters,
  assembleCounterReport,
  pruneCounters,
} from "./counters";

beforeEach(() => {
  H.state.limitRows = [];
  H.state.orderedRows = [];
  H.state.joinRows = [];
  H.state.deleteRows = [];
  H.state.upsert = {};
  vi.clearAllMocks();
});

describe("todayLocalDate", () => {
  it("formats a date as zero-padded YYYY-MM-DD in the local zone", () => {
    expect(todayLocalDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(todayLocalDate(new Date(2026, 8, 25, 8, 5))).toBe("2026-09-25");
  });
});

describe("upsertPrinterCounter (AC-2)", () => {
  it("keys the row on assetId + readingDate and writes the latest total (idempotent per day)", async () => {
    await upsertPrinterCounter("a1", 581856, "scheduled", new Date(2026, 8, 25, 10, 0));

    // Inserted values carry today's local date as the day key.
    expect(H.state.upsert.values).toMatchObject({
      assetId: "a1",
      readingDate: "2026-09-25",
      totalPages: 581856,
      source: "scheduled",
    });
    // The conflict target is the composite day key, so a second read the same
    // day updates the one row rather than inserting a duplicate.
    expect(Array.isArray(H.state.upsert.target)).toBe(true);
    expect((H.state.upsert.target as unknown[]).length).toBe(2);
    // On conflict the latest total wins.
    expect(H.state.upsert.set).toMatchObject({ totalPages: 581856, source: "scheduled" });
  });
});

describe("getPrinterCounters — panel + delta rules (AC-3)", () => {
  it("returns null when the tag is not a printer", async () => {
    H.state.limitRows = [[]]; // asset lookup finds nothing
    expect(await getPrinterCounters("NOT-A-PRINTER")).toBeNull();
  });

  it("returns an empty panel until the first reading lands", async () => {
    H.state.limitRows = [[{ id: "a1" }]];
    H.state.orderedRows = [[]]; // no counter rows yet
    const res = await getPrinterCounters("PRN-1");
    expect(res).toEqual({
      latestTotal: null,
      latestDate: null,
      latestDelta: null,
      latestNote: null,
      history: [],
    });
  });

  it("marks a single reading as 'first-reading' with no delta", async () => {
    H.state.limitRows = [[{ id: "a1" }]];
    H.state.orderedRows = [[{ readingDate: "2026-09-25", totalPages: 100 }]];
    const res = await getPrinterCounters("PRN-1");
    expect(res?.latestTotal).toBe(100);
    expect(res?.latestDelta).toBeNull();
    expect(res?.latestNote).toBe("first-reading");
    expect(res?.history[0]).toMatchObject({ totalPages: 100, delta: null, note: "first-reading" });
  });

  it("computes a +N day-over-day delta between two increasing days", async () => {
    H.state.limitRows = [[{ id: "a1" }]];
    H.state.orderedRows = [
      [
        { readingDate: "2026-09-26", totalPages: 150 }, // newest first
        { readingDate: "2026-09-25", totalPages: 100 },
      ],
    ];
    const res = await getPrinterCounters("PRN-1");
    expect(res?.latestDelta).toBe(50);
    expect(res?.latestNote).toBeNull();
  });

  it("reports 'counter-reset' and never a negative when the value dropped", async () => {
    H.state.limitRows = [[{ id: "a1" }]];
    H.state.orderedRows = [
      [
        { readingDate: "2026-09-26", totalPages: 80 }, // dropped below the prior day
        { readingDate: "2026-09-25", totalPages: 100 },
      ],
    ];
    const res = await getPrinterCounters("PRN-1");
    expect(res?.latestDelta).toBeNull();
    expect(res?.latestNote).toBe("counter-reset");
    for (const day of res?.history ?? []) {
      expect(day.delta === null || day.delta >= 0).toBe(true);
    }
  });
});

describe("assembleCounterReport — email rows (AC-4)", () => {
  const printer = (over: Record<string, unknown> = {}) => ({
    assetId: "a1",
    name: "Printer A",
    serial: "S1",
    locationId: null,
    ip: "10.0.0.5",
    ...over,
  });

  it("lists a printer's total and that day's delta", async () => {
    H.state.joinRows = [printer()];
    H.state.limitRows = [[{ totalPages: 150 }]]; // today
    H.state.orderedRows = [[{ totalPages: 100 }]]; // prior day
    const rows = await assembleCounterReport("2026-09-26");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Printer A", ip: "10.0.0.5", total: 150, delta: 50, note: null });
  });

  it("keeps a printer with no reading that day as 'no reading', showing the last known total", async () => {
    H.state.joinRows = [printer()];
    H.state.limitRows = [[]]; // no reading today
    H.state.orderedRows = [[{ totalPages: 120 }]]; // last known
    const rows = await assembleCounterReport("2026-09-26");
    expect(rows[0]).toMatchObject({ total: 120, delta: null, note: "no reading" });
  });

  it("labels a printer's first ever day 'first reading'", async () => {
    H.state.joinRows = [printer()];
    H.state.limitRows = [[{ totalPages: 100 }]]; // today
    H.state.orderedRows = [[]]; // no prior day
    const rows = await assembleCounterReport("2026-09-26");
    expect(rows[0]).toMatchObject({ total: 100, delta: null, note: "first reading" });
  });

  it("labels a drop 'counter reset' with no negative delta", async () => {
    H.state.joinRows = [printer()];
    H.state.limitRows = [[{ totalPages: 80 }]]; // today, below prior
    H.state.orderedRows = [[{ totalPages: 100 }]];
    const rows = await assembleCounterReport("2026-09-26");
    expect(rows[0]).toMatchObject({ total: 80, delta: null, note: "counter reset" });
  });

  it("skips a printer with a blank IP", async () => {
    H.state.joinRows = [printer({ ip: "   " })];
    const rows = await assembleCounterReport("2026-09-26");
    expect(rows).toEqual([]);
  });

  it("sorts the rows by printer name", async () => {
    H.state.joinRows = [
      printer({ assetId: "b", name: "Bravo", ip: "10.0.0.6", serial: null }),
      printer({ assetId: "a", name: "Alpha", ip: "10.0.0.5", serial: null }),
    ];
    H.state.limitRows = [[{ totalPages: 10 }], [{ totalPages: 20 }]]; // today for Bravo, then Alpha
    H.state.orderedRows = [[], []]; // neither has a prior day
    const rows = await assembleCounterReport("2026-09-26");
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("pruneCounters — retention (AC-6)", () => {
  it("returns the number of rows deleted", async () => {
    H.state.deleteRows = [{ assetId: "a" }, { assetId: "b" }, { assetId: "c" }];
    expect(await pruneCounters(365)).toBe(3);
  });

  it("still runs with a non-positive retention (defaults safely)", async () => {
    H.state.deleteRows = [{ assetId: "a" }];
    expect(await pruneCounters(0)).toBe(1);
    expect(H.deleteMock).toHaveBeenCalled();
  });
});
