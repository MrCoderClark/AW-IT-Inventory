// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { CompliancePanel } from "./compliance-panel";
import type { CompliancePosture } from "@/lib/compliance-score";

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
  assessedAt: "2026-10-08T12:00:00Z",
};

const ALL_UNKNOWN: CompliancePosture = {
  bitlocker: null,
  defenderRealtime: null,
  defenderSigAgeDays: null,
  avProduct: null,
  tpmReady: null,
  secureBoot: null,
  updatesLastDays: null,
  updatesPending: null,
  systemDrivePctUsed: null,
  assessedAt: "2026-10-08T12:00:00Z",
};

describe("CompliancePanel", () => {
  it("prompts to scan when there is no posture row", () => {
    render(<CompliancePanel posture={null} />);
    expect(screen.getByText(/No posture data yet/i)).toBeTruthy();
  });

  it("shows the score and all six checks for an assessed device", () => {
    render(<CompliancePanel posture={GREEN} />);
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("BitLocker")).toBeTruthy();
    expect(screen.getByText("Antivirus")).toBeTruthy();
    expect(screen.getByText("Windows Update")).toBeTruthy();
    expect(screen.getByText("Secure Boot")).toBeTruthy();
  });

  it("shows 'Not assessed' + remote-admin hint when every signal is unknown", () => {
    render(<CompliancePanel posture={ALL_UNKNOWN} />);
    expect(screen.getByText(/Not assessed/i)).toBeTruthy();
    expect(screen.getByText(/LocalAccountTokenFilterPolicy/)).toBeTruthy();
  });

  it("flags limited visibility when some signals are unreadable", () => {
    render(<CompliancePanel posture={{ ...GREEN, bitlocker: null }} />);
    expect(screen.getByText(/Limited visibility/i)).toBeTruthy();
  });
});
