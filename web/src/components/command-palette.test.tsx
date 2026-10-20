import { describe, it, expect } from "vitest";

import {
  NAV_PRIMARY,
  NAV_ASSETS,
  NAV_MANAGE,
  filterNavByPermissions,
} from "@/lib/data";

/**
 * The ⌘K palette must only offer destinations the user can actually open (RBAC
 * audit) — it jumps straight to the page, so an admin entry shown to a non-admin
 * is both a leak and a dead end. The palette feeds the combined nav list through
 * `filterNavByPermissions` (the same rule as the sidebar); this locks the result
 * for that exact input. (The sidebar test covers the component wiring of the same
 * helper; the cmdk dialog itself doesn't render cleanly under jsdom.)
 */
const ALL_NAV = [...NAV_PRIMARY, ...NAV_ASSETS, ...NAV_MANAGE];
const labels = (perms: string[]) =>
  filterNavByPermissions(ALL_NAV, perms).map((i) => i.label);

describe("command palette navigation gating", () => {
  it("offers admin + elevated destinations to a fully-permissioned user", () => {
    const l = labels([
      "asset:read",
      "asset:write",
      "scan:read",
      "software:deploy",
      "user:admin",
    ]);
    expect(l).toEqual(
      expect.arrayContaining([
        "Admin",
        "Software Library",
        "Scripts",
        "Scans",
        "People",
        "Media",
        "Ticketing",
      ]),
    );
  });

  it("hides admin + ungranted destinations from a plain asset:read viewer", () => {
    const l = labels(["asset:read", "report:read"]);
    // Baseline destinations remain.
    expect(l).toEqual(
      expect.arrayContaining(["Dashboard", "Computers", "Compliance", "Reports"]),
    );
    // Gated destinations are gone (People & Media now need asset:write).
    expect(l).toEqual(expect.arrayContaining(["Notifications"]));
    for (const hidden of [
      "Admin",
      "Users",
      "Roles",
      "Software Library",
      "Scripts",
      "Scans",
      "Scan Jobs",
      "People",
      "Media",
      "Ticketing",
    ]) {
      expect(l).not.toContain(hidden);
    }
  });

  it("shows scan items with scan:read but still hides admin/deploy", () => {
    const l = labels(["asset:read", "scan:read"]);
    expect(l).toEqual(expect.arrayContaining(["Scans", "Scan Jobs"]));
    expect(l).not.toContain("Admin");
    expect(l).not.toContain("Software Library");
    expect(l).not.toContain("Scripts");
  });
});
