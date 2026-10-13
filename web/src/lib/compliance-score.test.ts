import { describe, it, expect } from "vitest";

import {
  failingSecurityChecks,
  isAtRisk,
  scoreCompliance,
  type CompliancePosture,
} from "./compliance-score";

/** A fully-healthy posture; tests override one field at a time. */
const GREEN: CompliancePosture = {
  bitlocker: "on",
  defenderRealtime: true,
  defenderSigAgeDays: 2,
  avProduct: "Windows Defender",
  tpmReady: true,
  secureBoot: "on",
  updatesLastDays: 5,
  updatesPending: 0,
  systemDrivePctUsed: 40,
};

function statusOf(p: CompliancePosture, id: string) {
  return scoreCompliance(p).checks.find((c) => c.id === id)!.status;
}

describe("scoreCompliance", () => {
  it("all green → 100, assessed, no unknowns", () => {
    const r = scoreCompliance(GREEN);
    expect(r.score).toBe(100);
    expect(r.assessed).toBe(true);
    expect(r.unknownCount).toBe(0);
    expect(r.checks).toHaveLength(6);
  });

  it("scores a mixed device (updates behind, disk nearly full)", () => {
    const mixed = {
      ...GREEN,
      updatesLastDays: 37, // 🔴 fail → 0
      systemDrivePctUsed: 91, // 🟡 warn → 5
    };
    const r = scoreCompliance(mixed);
    // 25 + 25 + 0 + 10 + 10 + 5
    expect(r.score).toBe(75);
    expect(statusOf(mixed, "updates")).toBe("fail");
    expect(statusOf(mixed, "disk")).toBe("warn");
  });

  it("every signal unknown → not assessed (score null)", () => {
    const blank: CompliancePosture = {
      bitlocker: null,
      defenderRealtime: null,
      defenderSigAgeDays: null,
      avProduct: null,
      tpmReady: null,
      secureBoot: null,
      updatesLastDays: null,
      updatesPending: null,
      systemDrivePctUsed: null,
    };
    const r = scoreCompliance(blank);
    expect(r.assessed).toBe(false);
    expect(r.score).toBeNull();
    expect(r.unknownCount).toBe(6);
  });

  it("fail-closed: an unknown check earns 0 but is counted, not treated as pass", () => {
    const r = scoreCompliance({ ...GREEN, bitlocker: null });
    expect(r.assessed).toBe(true); // other signals are known
    expect(r.score).toBe(75); // lost BitLocker's 25
    expect(r.unknownCount).toBe(1);
    expect(statusOf({ ...GREEN, bitlocker: null }, "bitlocker")).toBe("unknown");
  });

  it("antivirus warn band: stale signatures earn half", () => {
    const r = scoreCompliance({ ...GREEN, defenderSigAgeDays: 20 });
    expect(statusOf({ ...GREEN, defenderSigAgeDays: 20 }, "antivirus")).toBe("warn");
    expect(r.score).toBe(100 - (25 - 12)); // 25 → 12
  });

  it("real-time protection off is a hard fail regardless of signatures", () => {
    expect(statusOf({ ...GREEN, defenderRealtime: false }, "antivirus")).toBe("fail");
  });
});

describe("failingSecurityChecks / isAtRisk", () => {
  it("a clean device is not at risk", () => {
    const r = scoreCompliance(GREEN);
    expect(failingSecurityChecks(r)).toHaveLength(0);
    expect(isAtRisk(r)).toBe(false);
  });

  it("flags hard security fails (BitLocker off, AV off)", () => {
    const r = scoreCompliance({
      ...GREEN,
      bitlocker: "off",
      defenderRealtime: false,
    });
    expect(isAtRisk(r)).toBe(true);
    expect(failingSecurityChecks(r).map((c) => c.id).sort()).toEqual([
      "antivirus",
      "bitlocker",
    ]);
  });

  it("ignores soft fails (updates/disk) — not a security alert", () => {
    const r = scoreCompliance({
      ...GREEN,
      updatesLastDays: 40, // fail, but soft
      systemDrivePctUsed: 99, // fail, but soft
    });
    expect(isAtRisk(r)).toBe(false);
    expect(failingSecurityChecks(r)).toHaveLength(0);
  });

  it("never at risk when not assessed (all unknown)", () => {
    const blank = scoreCompliance({
      bitlocker: null,
      defenderRealtime: null,
      defenderSigAgeDays: null,
      avProduct: null,
      tpmReady: null,
      secureBoot: null,
      updatesLastDays: null,
      updatesPending: null,
      systemDrivePctUsed: null,
    });
    expect(isAtRisk(blank)).toBe(false);
  });
});
