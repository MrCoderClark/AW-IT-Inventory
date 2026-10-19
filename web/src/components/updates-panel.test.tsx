// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { UpdatesPanel } from "./updates-panel";
import type { ComputerPatches } from "@/db/patches";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/app/(app)/patch-install-actions", () => ({
  requestPatchInstall: vi.fn(),
  requestCancelPatchInstall: vi.fn(),
}));

const SAMPLE: ComputerPatches = {
  pendingReboot: true,
  hotfixCount: 1,
  wingetAvailable: true,
  wingetDetail: null,
  appUpgradeCount: 1,
  collectedAt: "2026-10-19T16:00:00Z",
  updatesLastDays: 9,
  missingCount: 1,
  missingCollectedAt: "2026-10-19T17:00:00Z",
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
  missing: [
    {
      kbId: "KB9999999",
      title: "Cumulative Update",
      severity: "Important",
      sizeBytes: 1000,
    },
  ],
};

describe("UpdatesPanel", () => {
  it("prompts to scan when there is no patch row", () => {
    render(<UpdatesPanel patches={null} assetTag="PC1" />);
    expect(screen.getByText(/No patch inventory yet/i)).toBeTruthy();
  });

  it("shows pending reboot, missing KBs, installed KBs, and app upgrades", () => {
    render(<UpdatesPanel patches={SAMPLE} assetTag="PC1" />);
    expect(screen.getByText(/Pending reboot/i)).toBeTruthy();
    expect(screen.getByText(/1 missing/i)).toBeTruthy();
    expect(screen.getByText("KB9999999")).toBeTruthy();
    expect(screen.getByText("Cumulative Update")).toBeTruthy();
    expect(screen.getByText("KB5034441")).toBeTruthy();
    expect(screen.getByText("Google Chrome")).toBeTruthy();
    expect(screen.getByText("128.0")).toBeTruthy();
    expect(screen.getByText("129.0")).toBeTruthy();
    expect(screen.getByText(/9 days ago/i)).toBeTruthy();
  });

  it("shows Install selected when canInstall", () => {
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    expect(screen.getByRole("button", { name: /Install selected/i })).toBeTruthy();
    expect(screen.getByLabelText(/Select KB9999999/i)).toBeTruthy();
    expect(screen.getByLabelText(/Select Google.Chrome/i)).toBeTruthy();
  });

  it("explains when winget is unavailable", () => {
    render(
      <UpdatesPanel
        assetTag="PC1"
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
