import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exportExpiryUnix,
  mintExportFileSig,
  verifyExportFileSig,
} from "./software-export-sign";

const SECRET = "test-export-signing-secret";

beforeEach(() => {
  process.env.SOFTWARE_EXPORT_SIGNING_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.SOFTWARE_EXPORT_SIGNING_SECRET;
  vi.useRealTimers();
});

describe("mintExportFileSig / verifyExportFileSig", () => {
  const packageId = "pkg-1";
  const fileName = "setup.exe";
  const storageKey = "software/pkg-1/setup.exe";

  it("round-trips a valid signature", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-11-14T12:00:00Z"));
    const expUnix = exportExpiryUnix(3600);
    const sig = mintExportFileSig(packageId, fileName, storageKey, expUnix);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyExportFileSig(packageId, fileName, storageKey, expUnix, sig),
    ).toBe(true);
  });

  it("rejects a tampered field", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-11-14T12:00:00Z"));
    const expUnix = exportExpiryUnix(3600);
    const sig = mintExportFileSig(packageId, fileName, storageKey, expUnix);
    expect(
      verifyExportFileSig("other", fileName, storageKey, expUnix, sig),
    ).toBe(false);
    expect(
      verifyExportFileSig(packageId, "other.exe", storageKey, expUnix, sig),
    ).toBe(false);
    expect(
      verifyExportFileSig(packageId, fileName, "other/key", expUnix, sig),
    ).toBe(false);
    expect(
      verifyExportFileSig(packageId, fileName, storageKey, expUnix + 1, sig),
    ).toBe(false);
  });

  it("rejects an expired signature", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-11-14T12:00:00Z"));
    const exp = exportExpiryUnix(3600);
    const sig = mintExportFileSig(packageId, fileName, storageKey, exp);
    vi.setSystemTime(new Date("2024-11-14T14:00:01Z"));
    expect(
      verifyExportFileSig(packageId, fileName, storageKey, exp, sig),
    ).toBe(false);
  });

  it("accepts a signature still within TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-11-14T12:00:00Z"));
    const exp = exportExpiryUnix(3600);
    const sig = mintExportFileSig(packageId, fileName, storageKey, exp);
    vi.setSystemTime(new Date("2024-11-14T12:59:59Z"));
    expect(
      verifyExportFileSig(packageId, fileName, storageKey, exp, sig),
    ).toBe(true);
  });
});

describe("exportExpiryUnix", () => {
  it("defaults to now + 3600 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-11-14T12:00:00Z"));
    expect(exportExpiryUnix()).toBe(Math.floor(Date.now() / 1000) + 3600);
  });

  it("honors a custom TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-11-14T12:00:00Z"));
    expect(exportExpiryUnix(120)).toBe(Math.floor(Date.now() / 1000) + 120);
  });
});

describe("signing secret", () => {
  it("throws when SOFTWARE_EXPORT_SIGNING_SECRET is missing", () => {
    delete process.env.SOFTWARE_EXPORT_SIGNING_SECRET;
    expect(() =>
      mintExportFileSig("p", "f", "k", 1),
    ).toThrow(/SOFTWARE_EXPORT_SIGNING_SECRET/);
  });
});
