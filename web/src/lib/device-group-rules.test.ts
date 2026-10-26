import { describe, expect, it } from "vitest";

import {
  hasMeaningfulDeviceGroupRules,
  normalizeDeviceGroupRules,
} from "./device-group-rules";

describe("normalizeDeviceGroupRules", () => {
  it("trims and defaults compliance to any", () => {
    expect(
      normalizeDeviceGroupRules({
        locationId: "  loc-1  ",
        osContains: "  Win11  ",
        compliance: "any",
      }),
    ).toEqual({
      locationId: "loc-1",
      osContains: "Win11",
      compliance: "any",
    });
  });

  it("clears blank optional fields", () => {
    expect(
      normalizeDeviceGroupRules({
        locationId: " ",
        osContains: "",
        compliance: "ok",
      }),
    ).toEqual({
      locationId: null,
      osContains: null,
      compliance: "ok",
    });
  });
});

describe("hasMeaningfulDeviceGroupRules", () => {
  it("rejects an empty filter set", () => {
    expect(hasMeaningfulDeviceGroupRules({})).toBe(false);
    expect(
      hasMeaningfulDeviceGroupRules({
        locationId: null,
        osContains: null,
        compliance: "any",
      }),
    ).toBe(false);
  });

  it("accepts location, OS, or compliance filters", () => {
    expect(
      hasMeaningfulDeviceGroupRules({ locationId: "loc-1" }),
    ).toBe(true);
    expect(
      hasMeaningfulDeviceGroupRules({ osContains: "Windows 11" }),
    ).toBe(true);
    expect(
      hasMeaningfulDeviceGroupRules({ compliance: "at-risk" }),
    ).toBe(true);
  });
});
