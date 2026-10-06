import { describe, expect, it } from "vitest";

import { assetCsvValue, assetsToCsv } from "./csv";
import type { Asset } from "@/lib/data";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "OPUS-COMP-1",
    name: "Reception PC",
    type: "Computer",
    serial: "SN123",
    model: "OptiPlex 7090",
    assignee: { name: "Sam Lee", initials: "SL" },
    location: "HQ / Floor 2",
    locationId: "loc-1",
    status: "deployed",
    lastSync: "2026-10-01T08:30:00.000Z",
    vendor: "Dell",
    purchaseDate: "2024-01-01",
    warrantyUntil: "2027-01-01",
    costCenter: "CC-1",
    spec: "",
    ip: "192.168.70.20",
    ...overrides,
  } as Asset;
}

describe("assetCsvValue", () => {
  it("maps each column id to its plain-text value", () => {
    const a = makeAsset();
    expect(assetCsvValue(a, "id")).toBe("OPUS-COMP-1");
    expect(assetCsvValue(a, "name")).toBe("Reception PC");
    expect(assetCsvValue(a, "type")).toBe("Computer");
    expect(assetCsvValue(a, "serial")).toBe("SN123");
    expect(assetCsvValue(a, "model")).toBe("OptiPlex 7090");
    expect(assetCsvValue(a, "assignee")).toBe("Sam Lee");
    expect(assetCsvValue(a, "location")).toBe("HQ / Floor 2");
    expect(assetCsvValue(a, "status")).toBe("Deployed"); // STATUS_META label
    expect(assetCsvValue(a, "lastSync")).toBe("2026-10-01"); // date portion
    expect(assetCsvValue(a, "ip")).toBe("192.168.70.20");
    expect(assetCsvValue(a, "actions")).toBe("");
  });

  it("renders unassigned / missing values as empty strings", () => {
    const a = makeAsset({
      assignee: null,
      serial: "",
      model: "",
      lastSync: "",
      ip: undefined,
    });
    expect(assetCsvValue(a, "assignee")).toBe("");
    expect(assetCsvValue(a, "serial")).toBe("");
    expect(assetCsvValue(a, "model")).toBe("");
    expect(assetCsvValue(a, "lastSync")).toBe("");
    expect(assetCsvValue(a, "ip")).toBe("");
  });

  it("labels printer reachability by state", () => {
    const up = makeAsset({
      reachability: { state: "up", lastCheckedAt: null, downSince: null },
    });
    const down = makeAsset({
      reachability: { state: "down", lastCheckedAt: null, downSince: null },
    });
    expect(assetCsvValue(up, "reachability")).toBe("Up");
    expect(assetCsvValue(down, "reachability")).toBe("Down");
    expect(assetCsvValue(makeAsset(), "reachability")).toBe(""); // never checked
  });
});

describe("assetsToCsv", () => {
  it("writes a header of labels then one row per asset, dropping Actions", () => {
    const csv = assetsToCsv(
      [makeAsset()],
      ["id", "name", "status", "actions"],
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Asset ID,Asset Name,Status");
    expect(lines[1]).toBe("OPUS-COMP-1,Reception PC,Deployed");
    expect(lines).toHaveLength(2);
  });

  it("quotes and escapes fields with commas, quotes, or newlines (RFC 4180)", () => {
    const a = makeAsset({
      name: 'Lab "A", back room',
      location: "HQ\nFloor 2",
    });
    const csv = assetsToCsv([a], ["name", "location"]);
    const [, row] = csv.split("\r\n");
    // Comma + interior quotes → wrapped, quotes doubled; newline → wrapped.
    expect(row).toBe('"Lab ""A"", back room","HQ\nFloor 2"');
  });

  it("produces a header-only file when there are no rows", () => {
    const csv = assetsToCsv([], ["name", "status"]);
    expect(csv).toBe("Asset Name,Status");
  });
});
