import { describe, it, expect, vi, afterEach } from "vitest";

import { cellText, reportFilename, reportToCsv } from "./report-export";
import type { ReportResult } from "./report-spec";

/**
 * Unit tests for the pure report exporters (spec 26, slice 1c): the CSV
 * assembly, the shared cell formatting, and the filename slug. The Excel/PDF
 * paths depend on browser APIs + lazy-loaded office libs and are exercised
 * manually, not here.
 */

describe("cellText", () => {
  it("renders empties, booleans, numbers and trimmed dates", () => {
    expect(cellText(null, "text")).toBe("");
    expect(cellText("", "text")).toBe("");
    expect(cellText(true, "bool")).toBe("Yes");
    expect(cellText(false, "bool")).toBe("No");
    expect(cellText(1234.5, "number")).toBe("1234.5"); // no separators → re-imports cleanly
    expect(cellText("2026-10-14T09:30:00.000Z", "date")).toBe("2026-10-14");
    expect(cellText("2026-10-14", "date")).toBe("2026-10-14");
    expect(cellText("Dell", "text")).toBe("Dell");
  });
});

describe("reportToCsv", () => {
  const result: ReportResult = {
    columns: [
      { id: "name", label: "Name", type: "text" },
      { id: "ram", label: "RAM (GB)", type: "number" },
      { id: "atRisk", label: "At risk", type: "bool" },
    ],
    rows: [
      ["Laptop, A", 16, true],
      ['Quote "B"', null, false],
    ],
    totalRows: 2,
  };

  it("leads with a label header and joins rows with CRLF", () => {
    const csv = reportToCsv(result);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Name,RAM (GB),At risk');
  });

  it("quotes fields with commas or quotes per RFC 4180 and blanks nulls", () => {
    const lines = reportToCsv(result).split("\r\n");
    expect(lines[1]).toBe('"Laptop, A",16,Yes');
    expect(lines[2]).toBe('"Quote ""B""",,No');
  });
});

describe("reportFilename", () => {
  afterEach(() => vi.useRealTimers());

  it("slugs the name and stamps the date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    expect(reportFilename("Dell laptops — out of warranty!", "csv")).toBe(
      "opus-dell-laptops-out-of-warranty-2026-10-14.csv",
    );
    expect(reportFilename("   ", "xlsx")).toBe("opus-report-2026-10-14.xlsx");
  });
});
