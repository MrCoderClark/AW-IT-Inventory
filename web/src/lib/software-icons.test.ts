import { describe, it, expect } from "vitest";

import { resolveSoftwareIconUrl, softwareIconSrc } from "./software-icons";

describe("softwareIconSrc (spec 22)", () => {
  it("resolves a known title to its bundled icon path, case-insensitively", () => {
    expect(softwareIconSrc("AV Defender")).toBe("/software-icons/av-defender.png");
    expect(softwareIconSrc("av defender")).toBe("/software-icons/av-defender.png");
    expect(softwareIconSrc("  AV DEFENDER  ")).toBe(
      "/software-icons/av-defender.png",
    );
  });

  it("returns null for an unmapped title (generic glyph fallback)", () => {
    expect(softwareIconSrc("Google Chrome")).toBeNull();
    expect(softwareIconSrc("")).toBeNull();
  });
});

describe("resolveSoftwareIconUrl (spec 22)", () => {
  it("prefers a custom icon, cache-busted by iconUpdatedAt", () => {
    expect(
      resolveSoftwareIconUrl({
        id: "abc",
        name: "Chrome",
        iconKey: "software-icons/abc.png",
        iconUpdatedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).toBe("/api/software/abc/icon?v=2026-10-03T00%3A00%3A00.000Z");
  });

  it("omits the cache-bust when there is no timestamp", () => {
    expect(
      resolveSoftwareIconUrl({ id: "abc", name: "Chrome", iconKey: "k" }),
    ).toBe("/api/software/abc/icon");
  });

  it("falls back to the built-in registry, then null, with no custom icon", () => {
    expect(
      resolveSoftwareIconUrl({ id: "x", name: "AV Defender", iconKey: null }),
    ).toBe("/software-icons/av-defender.png");
    expect(
      resolveSoftwareIconUrl({ id: "x", name: "Google Chrome", iconKey: null }),
    ).toBeNull();
  });
});
