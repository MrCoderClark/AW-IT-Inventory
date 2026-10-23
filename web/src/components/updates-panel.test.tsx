// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { UpdatesPanel } from "./updates-panel";
import { pollUpdatesSnapshot } from "@/app/(app)/patch-install-actions";
import {
  deleteRebootScheduleAction,
  setRebootScheduleEnabledAction,
  upsertRebootScheduleAction,
} from "@/app/(app)/reboot-actions";
import type { ComputerPatches } from "@/db/patches";
import type { ScheduleListItem } from "@/db/reboot-schedules";
import type { RebootListItem } from "@/db/reboot";

vi.mock("@/app/(app)/patch-install-actions", () => ({
  requestPatchInstall: vi.fn(),
  requestCancelPatchInstall: vi.fn(),
  requestMissingUpdateCheck: vi.fn(),
  pollUpdatesSnapshot: vi.fn().mockResolvedValue({
    ok: true,
    patches: null,
    patchJobs: [],
    checkJobs: [],
    rebootJobs: [],
  }),
}));
vi.mock("@/app/(app)/reboot-actions", () => ({
  requestRebootSchedule: vi.fn(),
  requestCancelReboot: vi.fn(),
  upsertRebootScheduleAction: vi.fn(),
  setRebootScheduleEnabledAction: vi.fn(),
  deleteRebootScheduleAction: vi.fn(),
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
    vi.clearAllMocks();
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

  it("shows Schedule reboot controls when canInstall", () => {
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    expect(screen.getByRole("button", { name: /Schedule reboot/i })).toBeTruthy();
    expect(screen.getByLabelText(/Reboot date and time/i)).toBeTruthy();
    const btn = screen.getByRole("button", { name: /Schedule reboot/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the recurring reboot form when canInstall", () => {
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    expect(screen.getByLabelText(/Cadence/i)).toBeTruthy();
    expect(screen.getByLabelText(/Reboot time/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save schedule/i })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Mon" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: /Save schedule/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("hides recurring reboot controls without canInstall", () => {
    render(<UpdatesPanel patches={SAMPLE} assetTag="PC1" schedule={SAVED} />);
    expect(screen.queryByRole("button", { name: /Save schedule/i })).toBeNull();
  });

  it("shows weekday checkboxes for a weekly cadence", () => {
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    fireEvent.change(screen.getByLabelText(/Cadence/i), {
      target: { value: "weekly" },
    });
    expect(screen.getByRole("checkbox", { name: "Mon" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Sun" })).toBeTruthy();
    expect(screen.getByText(/Select at least one weekday/i)).toBeTruthy();
  });

  it("saves a daily schedule and applies the action payload", async () => {
    mockLiveSnapshot();
    vi.mocked(upsertRebootScheduleAction).mockResolvedValue({
      ok: true,
      id: "sch1",
      schedule: {
        ...SAVED,
        cadence: "daily",
        weekdays: null,
        localTime: "03:15",
        timezone: "Pacific/Auckland",
        nextRunAtIso: "2030-01-02T14:15:00.000Z",
      },
    });
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    fireEvent.change(screen.getByLabelText(/Reboot time/i), {
      target: { value: "03:15" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save schedule/i }));
    await waitFor(() => {
      expect(upsertRebootScheduleAction).toHaveBeenCalledWith(
        expect.objectContaining({
          assetTag: "PC1",
          cadence: "daily",
          localTime: "03:15",
        }),
      );
    });
    const arg = vi.mocked(upsertRebootScheduleAction).mock.calls[0][0];
    expect(arg.weekdays).toBeUndefined();
    expect(arg.timezone.length).toBeGreaterThan(0);
    expect(await screen.findByText(/Pacific\/Auckland/)).toBeTruthy();
    expect(screen.getByText(/2030/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Disable$/i })).toBeTruthy();
  });

  it("saves weekly weekdays as ISO Monday–Sunday", async () => {
    mockLiveSnapshot();
    vi.mocked(upsertRebootScheduleAction).mockResolvedValue({
      ok: true,
      id: "sch-week",
      schedule: null,
    });
    render(
      <UpdatesPanel patches={SAMPLE} assetTag="PC1" canInstall patchJobs={[]} />,
    );
    fireEvent.change(screen.getByLabelText(/Cadence/i), {
      target: { value: "weekly" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Wed" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Mon" }));
    fireEvent.change(screen.getByLabelText(/Reboot time/i), {
      target: { value: "02:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save schedule/i }));
    await waitFor(() => {
      expect(upsertRebootScheduleAction).toHaveBeenCalledWith(
        expect.objectContaining({
          assetTag: "PC1",
          cadence: "weekly",
          localTime: "02:00",
          weekdays: [1, 3],
        }),
      );
    });
    expect(await screen.findByRole("button", { name: /^Disable$/i })).toBeTruthy();
  });

  it("disables and deletes a saved schedule from local action results", async () => {
    mockLiveSnapshot();
    vi.mocked(setRebootScheduleEnabledAction).mockResolvedValue({ ok: true });
    vi.mocked(deleteRebootScheduleAction).mockResolvedValue({ ok: true });
    render(
      <UpdatesPanel
        patches={SAMPLE}
        assetTag="PC1"
        canInstall
        schedule={SAVED}
      />,
    );
    expect(screen.getByLabelText(/Reboot time/i)).toHaveProperty("value", "02:30");
    fireEvent.click(screen.getByRole("button", { name: /^Disable$/i }));
    await waitFor(() => {
      expect(setRebootScheduleEnabledAction).toHaveBeenCalledWith({
        assetTag: "PC1",
        enabled: false,
      });
    });
    expect(await screen.findByRole("button", { name: /^Enable$/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));
    await waitFor(() => {
      expect(deleteRebootScheduleAction).toHaveBeenCalledWith({ assetTag: "PC1" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Delete$/i })).toBeNull();
    });
    expect(screen.getByRole("button", { name: /Save schedule/i })).toBeTruthy();
  });

  it("marks reboot history that came from a schedule", () => {
    const base: RebootListItem = {
      id: "job-1",
      status: "succeeded",
      scheduledAt: "2026-10-19T12:00:00.000Z",
      sourcePatchInstallJobId: null,
      requestedBy: "alice",
      error: null,
      finishedAt: "2026-10-19T12:05:00.000Z",
      waitingForCollector: false,
      fromSchedule: false,
    };
    render(
      <UpdatesPanel
        patches={SAMPLE}
        assetTag="PC1"
        canInstall
        rebootJobs={[
          { ...base, fromSchedule: true },
          {
            ...base,
            id: "job-2",
            fromSchedule: false,
            sourceScheduleId: "sched-9",
          },
          { ...base, id: "job-3" },
        ]}
      />,
    );
    expect(screen.getAllByText(/· recurring/).length).toBe(2);
  });
});

const SAVED: ScheduleListItem = {
  id: "sch1",
  assetId: "a1",
  cadence: "weekly",
  weekdays: [1, 5],
  localTime: "02:30",
  timezone: "America/New_York",
  enabled: true,
  requestedBy: "me@opus.local",
  nextJobId: null,
  nextRunAtIso: "2030-01-06T07:30:00.000Z",
};

function mockLiveSnapshot() {
  vi.mocked(pollUpdatesSnapshot).mockResolvedValue({
    ok: true,
    patches: SAMPLE,
    patchJobs: [],
    checkJobs: [],
    rebootJobs: [],
  });
}
