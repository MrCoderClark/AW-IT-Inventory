// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PatchesFleet } from "./patches-fleet";
import type { FleetPatchRow } from "@/db/patches";
import { requestFleetOsPatchInstall } from "@/app/(app)/patch-install-actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/app/(app)/patch-install-actions", () => ({
  requestFleetOsPatchInstall: vi.fn(),
}));

const ROWS: FleetPatchRow[] = [
  {
    tag: "A",
    name: "Clean PC",
    assigneeName: "Ada Lovelace",
    pendingReboot: false,
    hotfixCount: 10,
    wingetAvailable: true,
    appUpgradeCount: 0,
    missingCount: 0,
    collectedAt: "2026-10-19T12:00:00Z",
    updatesLastDays: 5,
  },
  {
    tag: "B",
    name: "Needs reboot",
    assigneeName: null,
    pendingReboot: true,
    hotfixCount: 8,
    wingetAvailable: true,
    appUpgradeCount: 2,
    missingCount: 3,
    collectedAt: "2026-10-19T12:00:00Z",
    updatesLastDays: 40,
  },
  {
    tag: "C",
    name: "Never scanned",
    assigneeName: null,
    pendingReboot: null,
    hotfixCount: 0,
    wingetAvailable: null,
    appUpgradeCount: 0,
    missingCount: 0,
    collectedAt: null,
    updatesLastDays: null,
  },
];

describe("PatchesFleet", () => {
  beforeEach(() => {
    vi.mocked(requestFleetOsPatchInstall).mockReset();
  });

  it("shows assignee next to the computer name", () => {
    render(<PatchesFleet rows={ROWS} canDeploy={false} />);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getAllByText("Pool").length).toBeGreaterThanOrEqual(1);
  });

  it("hides Install OS updates without canDeploy", () => {
    render(<PatchesFleet rows={ROWS} canDeploy={false} />);
    expect(
      screen.queryByRole("button", { name: /Install OS updates/i }),
    ).toBeNull();
  });

  it("disables Install when nothing selected", () => {
    render(<PatchesFleet rows={ROWS} canDeploy />);
    const btn = screen.getByRole("button", { name: /Install OS updates/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirm copy mentions OS updates and no reboot", async () => {
    const user = userEvent.setup();
    render(<PatchesFleet rows={ROWS} canDeploy />);
    await user.click(screen.getByLabelText(/Select Needs reboot/i));
    await user.click(
      screen.getByRole("button", { name: /Install OS updates/i }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Install OS updates on 1 computer/i)).toBeTruthy();
    expect(within(dialog).getByText(/missing OS updates/i)).toBeTruthy();
    const description = within(dialog).getByText((_, el) => {
      return (
        el instanceof HTMLElement &&
        el.getAttribute("data-slot") === "dialog-description"
      );
    });
    expect(description.textContent).toMatch(/not/i);
    expect(description.textContent).toMatch(/reboot/i);
    expect(within(dialog).getByText(/rebooted automatically/i)).toBeTruthy();
    expect(within(dialog).getByText(/fleet concurrency limit/i)).toBeTruthy();
  });

  it("queues install on confirm and clears selection", async () => {
    vi.mocked(requestFleetOsPatchInstall).mockResolvedValue({
      ok: true,
      enqueued: ["jid"],
      skipped: [],
    });
    const user = userEvent.setup();
    render(<PatchesFleet rows={ROWS} canDeploy />);
    await user.click(screen.getByLabelText(/Select Needs reboot/i));
    await user.click(
      screen.getByRole("button", { name: /Install OS updates/i }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Install$/i }),
    );
    await waitFor(() =>
      expect(requestFleetOsPatchInstall).toHaveBeenCalledWith({
        assetTags: ["B"],
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/1 install queued/i);
    const installBtn = screen.getByRole("button", {
      name: /Install OS updates/i,
    });
    expect((installBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders every computer with a count", () => {
    render(<PatchesFleet rows={ROWS} />);
    expect(screen.getByText("Clean PC")).toBeTruthy();
    expect(screen.getByText("Needs reboot")).toBeTruthy();
    expect(screen.getByText("Never scanned")).toBeTruthy();
    expect(screen.getByText("3 of 3 computers")).toBeTruthy();
  });

  it("fleet confirm passes rebootAtIso when checked", async () => {
    vi.mocked(requestFleetOsPatchInstall).mockResolvedValue({
      ok: true,
      enqueued: ["jid"],
      skipped: [],
    });
    const user = userEvent.setup();
    render(<PatchesFleet rows={ROWS} canDeploy />);
    await user.click(screen.getByLabelText(/Select Needs reboot/i));
    await user.click(
      screen.getByRole("button", { name: /Install OS updates/i }),
    );
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByLabelText(/Also reboot at/i));
    await user.type(
      within(dialog).getByLabelText(/Reboot after install/i),
      "2026-12-01T14:30",
    );
    await user.click(within(dialog).getByRole("button", { name: /^Install$/i }));
    await waitFor(() =>
      expect(requestFleetOsPatchInstall).toHaveBeenCalledWith({
        assetTags: ["B"],
        rebootAtIso: new Date("2026-12-01T14:30").toISOString(),
      }),
    );
  });

  it("the needs-attention filter hides a clean computer", async () => {
    const user = userEvent.setup();
    render(<PatchesFleet rows={ROWS} />);
    await user.click(screen.getByRole("button", { name: /needs attention/i }));
    expect(screen.queryByText("Clean PC")).toBeNull();
    expect(screen.getByText("Needs reboot")).toBeTruthy();
    expect(screen.getByText("Never scanned")).toBeTruthy();
    expect(screen.getByText("2 of 3 computers")).toBeTruthy();
  });

  it("Install for group passes deviceGroupId", async () => {
    vi.mocked(requestFleetOsPatchInstall).mockResolvedValue({
      ok: true,
      enqueued: ["jid"],
      skipped: [],
    });
    const user = userEvent.setup();
    const groups = [{ id: "g1", name: "Win11 lab" }];
    render(<PatchesFleet rows={ROWS} canDeploy deviceGroups={groups} />);
    await user.click(
      screen.getByRole("combobox", { name: /Device group for OS install/i }),
    );
    await user.click(screen.getByRole("option", { name: /Win11 lab/i }));
    await user.click(
      screen.getByRole("button", { name: /Install for group/i }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/Install OS updates for “Win11 lab”/i),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: /^Install$/i }),
    );
    await waitFor(() =>
      expect(requestFleetOsPatchInstall).toHaveBeenCalledWith({
        deviceGroupId: "g1",
      }),
    );
  });
});
