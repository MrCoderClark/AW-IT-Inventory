import { afterEach, describe, it, expect, vi } from "vitest";

import { TAG_PREFIX, generateTag } from "./tags";
import { ASSET_TYPES } from "./asset-schema";
import type { AssetType } from "./data";

// The single tag helper shared by both create paths (the discovered-inbox
// quick-create and the manual asset form). Spec 08 AC-8: the tag prefix and the
// asset type always agree, and there is exactly one definition.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TAG_PREFIX", () => {
  it("maps each asset type to its expected prefix", () => {
    expect(TAG_PREFIX).toEqual({
      Computer: "COMP",
      Monitor: "MON",
      Printer: "PRNT",
      Phone: "PHN",
      Network: "NET",
    });
  });

  it("has a prefix for every asset type in the schema", () => {
    for (const type of ASSET_TYPES) {
      expect(TAG_PREFIX[type]).toBeTruthy();
    }
  });
});

describe("generateTag (AC-8)", () => {
  it("uses the prefix that matches the type", () => {
    for (const type of ASSET_TYPES) {
      expect(generateTag(type).startsWith(`OPUS-${TAG_PREFIX[type]}-`)).toBe(true);
    }
  });

  it("produces the OPUS-<PREFIX>-<suffix> shape with an uppercase base36 suffix", () => {
    const tag = generateTag("Monitor");
    expect(tag).toMatch(/^OPUS-MON-[A-Z0-9]{1,5}$/);
  });

  it("keeps the suffix uppercase", () => {
    const suffix = generateTag("Computer").split("-")[2];
    expect(suffix).toBe(suffix.toUpperCase());
  });

  it("derives the suffix from Math.random (deterministic under a fixed seed)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);
    const first = generateTag("Phone");
    const second = generateTag("Phone");
    expect(first).toBe(second);
    expect(first.startsWith("OPUS-PHN-")).toBe(true);
  });

  it("generates differing tags across calls with real randomness", () => {
    const tags = new Set(
      Array.from({ length: 20 }, () => generateTag("Network" as AssetType)),
    );
    // Not a strict guarantee, but 20 real-random suffixes colliding would signal
    // the generator lost its entropy.
    expect(tags.size).toBeGreaterThan(1);
  });
});
