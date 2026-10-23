import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec 26 computer audit report source. The DB client and location path lookup
 * are mocked; `runReportBySpec` must accept `computerAuditEvents` and project
 * the catalog field ids (ISO dates, location path).
 */

const H = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const wheres: unknown[] = [];
  const makeBuilder = () => {
    const builder: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "groupBy", "orderBy", "limit"]) {
      builder[m] = () => builder;
    }
    builder.where = (clause: unknown) => {
      wheres.push(clause);
      return builder;
    };
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
    return builder;
  };
  const selectMock = vi.fn(() => makeBuilder());
  return { queue, wheres, selectMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/queries", () => ({
  getLocationPathMap: vi.fn(async () => new Map([["loc-1", "HQ / Floor 2"]])),
  getPrinterCounterMap: vi.fn(async () => ({})),
}));
vi.mock("@/db/index", () => ({ db: { select: H.selectMock } }));

import { runReportBySpec } from "./report-engine";
import type { ReportSpec } from "@/lib/report-spec";

const COLUMNS = [
  "occurredAt",
  "assetTag",
  "assetName",
  "serial",
  "action",
  "status",
  "operator",
  "source",
  "summary",
  "flagged",
  "location",
];

function spec(filters: ReportSpec["filters"] = []): ReportSpec {
  return { source: "computerAuditEvents", columns: COLUMNS, filters };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    occurredAt: new Date("2026-10-23T16:00:00.000Z"),
    assetTag: "PC-1",
    assetName: "Front desk",
    serial: "SN-1",
    action: "reboot",
    status: "succeeded",
    operator: "jclark",
    source: "admin_console",
    summary: "Rebooted",
    flagged: true,
    locationId: "loc-1",
    ...overrides,
  };
}

function asRecord(result: Awaited<ReturnType<typeof runReportBySpec>>, index = 0) {
  return Object.fromEntries(result.columns.map((c, i) => [c.id, result.rows[index][i]]));
}

beforeEach(() => {
  H.queue.length = 0;
  H.wheres.length = 0;
  vi.clearAllMocks();
});

describe("runReportBySpec computerAuditEvents", () => {
  it("accepts the source and maps ISO dates, location, and flagged", async () => {
    H.queue.push([
      row(),
      row({
        occurredAt: new Date("2026-10-22T16:00:00.000Z"),
        assetTag: "PC-2",
        serial: null,
        flagged: false,
        locationId: null,
        summary: "No location",
      }),
    ]);

    const result = await runReportBySpec(spec());

    expect(result.totalRows).toBe(2);
    expect(result.columns.map((c) => c.id)).toEqual(COLUMNS);
    expect(asRecord(result)).toMatchObject({
      occurredAt: "2026-10-23T16:00:00.000Z",
      assetTag: "PC-1",
      assetName: "Front desk",
      serial: "SN-1",
      action: "reboot",
      status: "succeeded",
      operator: "jclark",
      source: "admin_console",
      summary: "Rebooted",
      flagged: true,
      location: "HQ / Floor 2",
    });
    expect(asRecord(result, 1)).toMatchObject({
      occurredAt: "2026-10-22T16:00:00.000Z",
      assetTag: "PC-2",
      serial: null,
      flagged: false,
      location: null,
    });
  });

  it("pushes an enum filter and still applies it in memory", async () => {
    H.queue.push([row({ action: "reboot" }), row({ action: "software_deploy", assetTag: "PC-2" })]);

    const result = await runReportBySpec(
      spec([{ field: "action", op: "in", values: ["reboot"] }]),
    );

    expect(H.wheres[0]).toBeTruthy();
    expect(result.totalRows).toBe(1);
    expect(asRecord(result).assetTag).toBe("PC-1");
  });

  it("leaves date filters to memory", async () => {
    H.queue.push([
      row(),
      row({ occurredAt: new Date("2026-10-22T16:00:00.000Z"), assetTag: "PC-2" }),
    ]);

    const result = await runReportBySpec(
      spec([{ field: "occurredAt", op: "on", value: "2026-10-23" }]),
    );

    expect(H.wheres[0]).toBeUndefined();
    expect(result.totalRows).toBe(1);
    expect(asRecord(result).occurredAt).toBe("2026-10-23T16:00:00.000Z");
  });

  it("throws on an unknown source", async () => {
    await expect(
      runReportBySpec({ source: "not-a-source", columns: ["tag"], filters: [] }),
    ).rejects.toThrow("Unknown report source: not-a-source");
  });
});
