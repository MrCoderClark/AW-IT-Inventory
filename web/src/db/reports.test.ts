import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the reports aggregates (backlog "Reports page"). The DB client
 * and the location path lookup are the boundary and are mocked; the bucketing
 * math (warranty windows, age bands, assigned-vs-pool) runs for real against a
 * frozen "today" so the day-relative rules are deterministic.
 */

const H = vi.hoisted(() => {
  // Each awaited query shifts the next canned result off this queue, in the
  // order the function under test issues its selects.
  const queue: unknown[][] = [];
  const makeBuilder = () => {
    const builder: Record<string, unknown> = {};
    for (const m of [
      "from",
      "leftJoin",
      "innerJoin",
      "where",
      "groupBy",
      "orderBy",
      "limit",
    ]) {
      builder[m] = () => builder;
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
    return builder;
  };
  const selectMock = vi.fn(() => makeBuilder());
  return { queue, selectMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/queries", () => ({
  getLocationPathMap: vi.fn(async () => new Map([["loc-1", "HQ / Floor 2"]])),
}));
vi.mock("@/db/index", () => ({ db: { select: H.selectMock } }));

import {
  getAgingReport,
  getAssignmentSummary,
  getWarrantyReport,
} from "./reports";

beforeEach(() => {
  H.queue.length = 0;
  vi.clearAllMocks();
  // Freeze "today" so day-relative buckets are stable.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getWarrantyReport", () => {
  it("buckets by days-until and lists only expired + ≤90-day rows, soonest first", async () => {
    H.queue.push([
      // expired 9 months ago
      { tag: "A", name: "Alpha", type: "Computer", vendor: "Dell", warrantyUntil: "2026-01-01", status: "deployed", locationId: "loc-1", assignee: "Sam" },
      // expiring in 15 days → soon
      { tag: "B", name: "Bravo", type: "Printer", vendor: "HP", warrantyUntil: "2026-10-20", status: "online", locationId: null, assignee: null },
      // expiring in 57 days → upcoming
      { tag: "C", name: "Charlie", type: "Monitor", vendor: "LG", warrantyUntil: "2026-12-01", status: "deployed", locationId: null, assignee: null },
      // a year out → ok (not listed)
      { tag: "D", name: "Delta", type: "Phone", vendor: "Apple", warrantyUntil: "2027-10-05", status: "storage", locationId: null, assignee: null },
      // no date → unknown
      { tag: "E", name: "Echo", type: "Network", vendor: null, warrantyUntil: null, status: "deployed", locationId: null, assignee: null },
    ]);

    const report = await getWarrantyReport();

    expect(report.counts).toEqual({
      expired: 1,
      soon: 1,
      upcoming: 1,
      ok: 1,
      unknown: 1,
    });
    expect(report.total).toBe(5);
    // Only expired + soon + upcoming, soonest (most negative daysLeft) first.
    expect(report.rows.map((r) => r.tag)).toEqual(["A", "B", "C"]);
    expect(report.rows[0].bucket).toBe("expired");
    expect(report.rows[0].daysLeft).toBeLessThan(0);
    expect(report.rows[1].bucket).toBe("soon");
    expect(report.rows[1].daysLeft).toBe(15);
    // Location path resolves through the mocked map.
    expect(report.rows[0].location).toBe("HQ / Floor 2");
  });

  it("is empty when nothing is expiring within 90 days", async () => {
    H.queue.push([
      { tag: "D", name: "Delta", type: "Phone", vendor: "Apple", warrantyUntil: "2027-10-05", status: "storage", locationId: null, assignee: null },
    ]);
    const report = await getWarrantyReport();
    expect(report.rows).toHaveLength(0);
    expect(report.counts.ok).toBe(1);
  });
});

describe("getAgingReport", () => {
  it("buckets by age band and returns the oldest first", async () => {
    H.queue.push([
      { tag: "A", name: "Alpha", type: "Computer", vendor: "Dell", purchaseDate: "2026-06-01", status: "deployed", locationId: "loc-1" }, // < 1yr
      { tag: "B", name: "Bravo", type: "Computer", vendor: "Dell", purchaseDate: "2024-06-01", status: "deployed", locationId: null }, // ~2yr
      { tag: "C", name: "Charlie", type: "Monitor", vendor: "LG", purchaseDate: "2022-01-01", status: "deployed", locationId: null }, // ~4.7yr
      { tag: "D", name: "Delta", type: "Printer", vendor: "HP", purchaseDate: "2019-01-01", status: "maintenance", locationId: null }, // ~7.7yr
      { tag: "E", name: "Echo", type: "Network", vendor: null, purchaseDate: null, status: "deployed", locationId: null }, // unknown
    ]);

    const report = await getAgingReport();

    expect(report.counts).toEqual({
      under1: 1,
      y1to3: 1,
      y3to5: 1,
      over5: 1,
      unknown: 1,
    });
    expect(report.total).toBe(5);
    // Oldest purchase date first.
    expect(report.oldest.map((r) => r.tag)).toEqual(["D", "C", "B", "A"]);
    expect(report.oldest[0].ageYears).toBe(7);
  });
});

describe("getAssignmentSummary", () => {
  it("derives pool counts, orders types, and totals correctly", async () => {
    // typeRows then holderRows (the two selects, in issue order).
    H.queue.push([
      { type: "Monitor", total: 10, assigned: 4 },
      { type: "Computer", total: 20, assigned: 15 },
    ]);
    H.queue.push([
      { id: "p1", name: "Sam", department: "IT", jobTitle: "Admin", deviceCount: 9 },
      { id: "p2", name: "Rae", department: null, jobTitle: null, deviceCount: 6 },
    ]);

    const summary = await getAssignmentSummary();

    expect(summary.total).toBe(30);
    expect(summary.assigned).toBe(19);
    expect(summary.unassigned).toBe(11);
    expect(summary.peopleWithDevices).toBe(2);
    // Canonical type order: Computer before Monitor.
    expect(summary.byType.map((r) => r.type)).toEqual(["Computer", "Monitor"]);
    expect(summary.byType[0]).toMatchObject({ assigned: 15, unassigned: 5, total: 20 });
    expect(summary.topHolders[0]).toMatchObject({ name: "Sam", deviceCount: 9 });
  });
});
