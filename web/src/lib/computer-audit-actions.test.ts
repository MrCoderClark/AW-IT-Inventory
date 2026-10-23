import { describe, it, expect } from "vitest";
import { formatAppUpgradeSummary, formatInstallSummary } from "./computer-audit-actions";

describe("formatInstallSummary", () => {
  it("includes version when present", () => {
    expect(formatInstallSummary("VLC", "3.0.20")).toBe("Installed VLC 3.0.20");
  });
  it("omits version when null", () => {
    expect(formatInstallSummary("VLC", null)).toBe("Installed VLC");
  });
});

describe("formatAppUpgradeSummary", () => {
  it("shows from → to", () => {
    expect(formatAppUpgradeSummary("Chrome", "128.0", "129.0")).toBe(
      "Updated Chrome 128.0 → 129.0",
    );
  });
});
