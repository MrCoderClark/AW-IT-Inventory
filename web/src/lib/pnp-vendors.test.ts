import { describe, it, expect } from "vitest";

import { isExternalMonitor, vendorName } from "./pnp-vendors";

describe("vendorName", () => {
  it("maps known PnP codes and falls back to the upper-cased code", () => {
    expect(vendorName("DEL")).toBe("Dell");
    expect(vendorName("gsm")).toBe("LG");
    expect(vendorName("ZZZ")).toBe("ZZZ");
    expect(vendorName(null)).toBeNull();
    expect(vendorName("  ")).toBeNull();
  });
});

describe("isExternalMonitor", () => {
  it("treats brand-code displays with a serial as external", () => {
    expect(isExternalMonitor("DEL", "ABC123")).toBe(true); // Dell monitor
    expect(isExternalMonitor("SAM", "S1")).toBe(true); // Samsung monitor
    expect(isExternalMonitor("GSM", "L1")).toBe(true); // LG monitor
  });

  it("skips built-in / OEM panel makers", () => {
    expect(isExternalMonitor("AUO", "P1")).toBe(false); // AU Optronics panel
    expect(isExternalMonitor("boe", "P2")).toBe(false); // case-insensitive
    expect(isExternalMonitor("LGD", "P3")).toBe(false); // LG Display panel
    expect(isExternalMonitor("SDC", "P4")).toBe(false); // Samsung Display panel
  });

  it("requires a serial (the dedup/match key)", () => {
    expect(isExternalMonitor("DEL", null)).toBe(false);
    expect(isExternalMonitor("DEL", "  ")).toBe(false);
  });

  it("does NOT auto-add an unknown/unmapped vendor (conservative)", () => {
    expect(isExternalMonitor("XYZ", "S9")).toBe(false); // not in PNP_VENDORS
    expect(isExternalMonitor(null, "S9")).toBe(false); // no vendor code
  });
});
