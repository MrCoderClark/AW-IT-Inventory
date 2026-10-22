// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UpdatesPanel } from "./updates-panel";
import type { ComputerPatches } from "@/db/patches";
import { requestPatchInstall } from "@/app/(app)/patch-install-actions";
import { requestRebootSchedule } from "@/app/(app)/reboot-actions";

vi.mock("@/app/(app)/patch-install-actions", () => ({
  requestPatchInstall: vi.fn(),
  requestCancelPatchInstall: vi.fn(),
  requestMissingUpdateCheck: vi.fn(),
  pollUpdatesSnapshot: vi.fn(),
}));
vi.mock("@/app/(app)/reboot-actions", () => ({
  requestRebootSchedule: vi.fn(),
  requestCancelReboot: vi.fn(),
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
  beforeEach(() => {
    vi.mocked(requestPatchInstall).mockReset();
    vi.mocked(requestRebootSchedule).mockReset();
  });

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

  it("shows Install selected and Check for updates when canInstall", () => {
    render(
      <UpdatesPanel
        patches={SAMPLE}
        assetTag="PC1"
        canInstall
        patchJobs={[]}
        checkJobs={[]}
      />,
    );
    expect(screen.getByRole("button", { name: /Install selected/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check for updates/i })).toBeTruthy();
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

  it("shows Schedule reboot when canInstall", () => {
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    expect(screen.getByRole("button", { name: /Schedule reboot/i })).toBeTruthy();
    expect(screen.getByLabelText(/Reboot date and time/i)).toBeTruthy();
    const rebootPanel = screen
      .getByRole("heading", { name: /Scheduled reboot/i })
      .closest("section");
    expect(rebootPanel?.textContent).toMatch(/forced reboot/i);
  });

  it("requires datetime for Schedule reboot", () => {
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    const btn = screen.getByRole("button", { name: /Schedule reboot/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("install confirm Also reboot requires datetime", async () => {
    const user = userEvent.setup();
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    await user.click(screen.getByLabelText(/Select KB9999999/i));
    await user.click(screen.getByRole("button", { name: /Install selected/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByLabelText(/Also reboot at/i));
    const installBtn = within(dialog).getByRole("button", { name: /^Install$/i });
    expect((installBtn as HTMLButtonElement).disabled).toBe(true);
    await user.type(
      within(dialog).getByLabelText(/Reboot after install/i),
      "2026-12-01T14:30",
    );
    expect((installBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("passes rebootAtIso on install when also reboot checked", async () => {
    vi.mocked(requestPatchInstall).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    await user.click(screen.getByLabelText(/Select KB9999999/i));
    await user.click(screen.getByRole("button", { name: /Install selected/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByLabelText(/Also reboot at/i));
    await user.type(
      within(dialog).getByLabelText(/Reboot after install/i),
      "2026-12-01T14:30",
    );
    await user.click(within(dialog).getByRole("button", { name: /^Install$/i }));
    await waitFor(() =>
      expect(requestPatchInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          assetTag: "PC1",
          rebootAtIso: new Date("2026-12-01T14:30").toISOString(),
        }),
      ),
    );
  });
});
