// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { UpdatesPanel } from "./updates-panel";
import type { ComputerPatches } from "@/db/patches";

const SAMPLE: ComputerPatches = {
  pendingReboot: true,
  hotfixCount: 1,
  wingetAvailable: true,
  wingetDetail: null,
  appUpgradeCount: 1,
  collectedAt: "2026-10-19T16:00:00Z",
  updatesLastDays: 9,
  hotfixes: [
    {
      hotfixId: "KB5034441",
      description: "Security Update",
      installedOn: "2024-01-15",
    },
  ],
  appUpgrades: [
    {
      packageId: "Google.Chrome",
      name: "Google Chrome",
      version: "128.0",
      available: "129.0",
      source: "winget",
    },
  ],
};

describe("UpdatesPanel", () => {
  it("prompts to scan when there is no patch row", () => {
    render(<UpdatesPanel patches={null} />);
    expect(screen.getByText(/No patch inventory yet/i)).toBeTruthy();
  });

  it("shows pending reboot, KBs, and app upgrades", () => {
    render(<UpdatesPanel patches={SAMPLE} />);
    expect(screen.getByText(/Pending reboot/i)).toBeTruthy();
    expect(screen.getByText("KB5034441")).toBeTruthy();
    expect(screen.getByText("Google Chrome")).toBeTruthy();
    expect(screen.getByText("128.0")).toBeTruthy();
    expect(screen.getByText("129.0")).toBeTruthy();
    expect(screen.getByText(/9 days ago/i)).toBeTruthy();
  });

  it("explains when winget is unavailable", () => {
    render(
      <UpdatesPanel
        patches={{
          ...SAMPLE,
          wingetAvailable: false,
          wingetDetail: "no InstallLocation winget.exe",
          appUpgradeCount: 0,
          appUpgrades: [],
        }}
      />,
    );
    expect(screen.getByText(/Winget not usable over WinRM/i)).toBeTruthy();
    expect(screen.getByText(/no InstallLocation winget.exe/i)).toBeTruthy();
  });
});
