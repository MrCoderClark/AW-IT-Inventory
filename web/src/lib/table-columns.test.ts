import { describe, it, expect } from "vitest";

import {
  COLUMN_VIEWS,
  catalogFor,
  defaultsFor,
  isColumnView,
  isLockedColumn,
  resolveColumns,
  sanitizeColumns,
  type ColumnView,
} from "./table-columns";

/**
 * Unit tests for the code-owned catalog, defaults, and render rule (spec 11).
 * This module is the single source of which columns a view may show, which it
 * shows by default, and how a saved layout is resolved. The invariants here back
 * AC-2 (defaults unchanged / saved layout render), AC-3 (per-view catalog), and
 * AC-6 (catalog filtering, locked columns, stale-id tolerance).
 */

describe("catalogFor (AC-3)", () => {
  it("offers shared + IP for printers, and never Type, MAC, or Phone", () => {
    const c = catalogFor("printer");
    expect(c).toContain("ip");
    expect(c).not.toContain("mac");
    expect(c).not.toContain("phoneNumber");
    expect(c).not.toContain("type");
  });

  it("offers shared + IP + MAC for network gear", () => {
    const c = catalogFor("network");
    expect(c).toContain("ip");
    expect(c).toContain("mac");
    expect(c).not.toContain("phoneNumber");
    expect(c).not.toContain("type");
  });

  it("offers shared + Phone for phones", () => {
    const c = catalogFor("phone");
    expect(c).toContain("phoneNumber");
    expect(c).not.toContain("ip");
    expect(c).not.toContain("mac");
    expect(c).not.toContain("type");
  });

  it("offers no type-specific identifier columns for computers or monitors", () => {
    for (const view of ["computer", "monitor"] as ColumnView[]) {
      const c = catalogFor(view);
      expect(c).not.toContain("ip");
      expect(c).not.toContain("mac");
      expect(c).not.toContain("phoneNumber");
      expect(c).not.toContain("type");
    }
  });

  it("offers Type but no identifier columns for the mixed dashboard/location views", () => {
    for (const view of ["dashboard", "location"] as ColumnView[]) {
      const c = catalogFor(view);
      expect(c).toContain("type");
      expect(c).not.toContain("ip");
      expect(c).not.toContain("mac");
      expect(c).not.toContain("phoneNumber");
    }
  });

  it("always includes the locked Name and Actions columns", () => {
    for (const view of COLUMN_VIEWS) {
      const c = catalogFor(view);
      expect(c).toContain("name");
      expect(c).toContain("actions");
    }
  });
});

describe("defaultsFor (AC-2, matches today's hardcoded columns)", () => {
  const expected: Record<ColumnView, string[]> = {
    computer: ["id", "name", "model", "serial", "assignee", "location", "status", "lastSync", "actions"],
    monitor: ["id", "name", "model", "serial", "assignee", "location", "status", "actions"],
    printer: ["id", "name", "model", "serial", "ip", "location", "status", "lastSync", "actions"],
    network: ["id", "name", "model", "serial", "ip", "mac", "location", "status", "actions"],
    phone: ["id", "name", "model", "serial", "phoneNumber", "assignee", "location", "status", "actions"],
    dashboard: ["id", "name", "type", "serial", "model", "assignee", "location", "status", "lastSync", "actions"],
    location: ["id", "name", "type", "serial", "model", "assignee", "location", "status", "lastSync", "actions"],
  };

  for (const view of COLUMN_VIEWS) {
    it(`renders the exact default columns for ${view}`, () => {
      expect(defaultsFor(view)).toEqual(expected[view]);
    });
  }

  it("keeps every default column inside that view's catalog", () => {
    for (const view of COLUMN_VIEWS) {
      const catalog = catalogFor(view);
      for (const id of defaultsFor(view)) {
        expect(catalog).toContain(id);
      }
    }
  });
});

describe("resolveColumns — no saved row falls back to defaults (AC-2)", () => {
  it("returns the view's exact defaults when saved is null", () => {
    expect(resolveColumns("printer", null, { anyAssignee: true })).toEqual(
      defaultsFor("printer"),
    );
    expect(resolveColumns("dashboard", null, { anyAssignee: true })).toEqual(
      defaultsFor("dashboard"),
    );
  });

  it("drops Assigned To on a mixed view when nothing shown is assigned to a person", () => {
    const dash = resolveColumns("dashboard", null, { anyAssignee: false });
    expect(dash).not.toContain("assignee");
    // ...but keeps it when something is assigned.
    expect(resolveColumns("dashboard", null, { anyAssignee: true })).toContain(
      "assignee",
    );
  });

  it("never applies the dynamic Assigned To drop to a category view", () => {
    // A category default (computer) carries assignee; anyAssignee=false must not
    // strip it, because the drop is a mixed-view behavior only.
    expect(resolveColumns("computer", null, { anyAssignee: false })).toContain(
      "assignee",
    );
  });
});

describe("resolveColumns — a saved row governs, filtered through the catalog (AC-2, AC-6)", () => {
  it("honors the saved ids and their order", () => {
    const saved = ["name", "ip", "status", "location", "actions"];
    expect(resolveColumns("printer", saved)).toEqual([
      "name",
      "ip",
      "status",
      "location",
      "actions",
    ]);
  });

  it("drops a saved id that is not in the view's catalog", () => {
    // MAC is not a printer column; it must be dropped on render.
    const saved = ["name", "mac", "status", "actions"];
    expect(resolveColumns("printer", saved)).toEqual([
      "name",
      "status",
      "actions",
    ]);
  });

  it("skips a stale id no longer known to the code catalog without erroring", () => {
    const saved = ["name", "totallyGone", "status", "actions"];
    expect(resolveColumns("printer", saved)).toEqual([
      "name",
      "status",
      "actions",
    ]);
  });

  it("dedupes repeated ids, keeping first position", () => {
    const saved = ["name", "status", "status", "location", "actions"];
    expect(resolveColumns("printer", saved)).toEqual([
      "name",
      "status",
      "location",
      "actions",
    ]);
  });
});

describe("resolveColumns — locked columns are always enforced (AC-4, AC-6)", () => {
  it("injects Name first when a saved row omits it", () => {
    const result = resolveColumns("printer", ["status", "ip", "actions"]);
    expect(result[0]).toBe("name");
  });

  it("appends Actions last when a saved row omits it", () => {
    const result = resolveColumns("printer", ["name", "status", "ip"]);
    expect(result[result.length - 1]).toBe("actions");
  });

  it("moves Actions to the end when a saved row places it in the middle", () => {
    const result = resolveColumns("printer", ["name", "actions", "status"]);
    expect(result[result.length - 1]).toBe("actions");
    expect(result.filter((id) => id === "actions")).toHaveLength(1);
  });

  it("yields a usable Name + Actions table from an empty saved array", () => {
    expect(resolveColumns("printer", [])).toEqual(["name", "actions"]);
  });

  it("treats null (no row) and [] (saved empty) differently", () => {
    expect(resolveColumns("printer", null)).toEqual(defaultsFor("printer"));
    expect(resolveColumns("printer", [])).toEqual(["name", "actions"]);
  });
});

describe("sanitizeColumns — the write-side trust boundary (AC-6)", () => {
  it("keeps valid ids and forces the locked columns", () => {
    expect(sanitizeColumns("printer", ["name", "ip", "serial", "actions"])).toEqual([
      "name",
      "ip",
      "serial",
      "actions",
    ]);
  });

  it("drops ids outside the view's catalog before writing", () => {
    // Phone number is not a printer column.
    expect(sanitizeColumns("printer", ["name", "phoneNumber", "actions"])).toEqual([
      "name",
      "actions",
    ]);
  });

  it("strips non-string entries from the submitted list", () => {
    expect(
      sanitizeColumns("printer", ["name", 5, "status", null, "actions"]),
    ).toEqual(["name", "status", "actions"]);
  });

  it("falls back to Name + Actions when given a non-array", () => {
    expect(sanitizeColumns("printer", undefined)).toEqual(["name", "actions"]);
    expect(sanitizeColumns("printer", "id,name")).toEqual(["name", "actions"]);
  });
});

describe("isColumnView / isLockedColumn (AC-4, AC-8 view validation)", () => {
  it("accepts every real view key", () => {
    for (const view of COLUMN_VIEWS) {
      expect(isColumnView(view)).toBe(true);
    }
  });

  it("rejects unknown or non-string view values", () => {
    for (const bad of ["bogus", "", "Computer", null, undefined, 7, {}]) {
      expect(isColumnView(bad)).toBe(false);
    }
  });

  it("marks only Name and Actions as locked", () => {
    expect(isLockedColumn("name")).toBe(true);
    expect(isLockedColumn("actions")).toBe(true);
    for (const id of ["id", "status", "ip", "assignee", "type"] as const) {
      expect(isLockedColumn(id)).toBe(false);
    }
  });
});
