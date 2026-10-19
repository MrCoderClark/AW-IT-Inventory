// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PatchesFleet } from "./patches-fleet";
import type { FleetPatchRow } from "@/db/patches";

const ROWS: FleetPatchRow[] = [
  {
    tag: "A",
    name: "Clean PC",
    pendingReboot: false,
    hotfixCount: 10,
    wingetAvailable: true,
    appUpgradeCount: 0,
    collectedAt: "2026-10-19T12:00:00Z",
    updatesLastDays: 5,
  },
  {
    tag: "B",
    name: "Needs reboot",
    pendingReboot: true,
    hotfixCount: 8,
    wingetAvailable: true,
    appUpgradeCount: 2,
    collectedAt: "2026-10-19T12:00:00Z",
    updatesLastDays: 40,
  },
  {
    tag: "C",
    name: "Never scanned",
    pendingReboot: null,
    hotfixCount: 0,
    wingetAvailable: null,
    appUpgradeCount: 0,
    collectedAt: null,
    updatesLastDays: null,
  },
];

describe("PatchesFleet", () => {
  it("renders every computer with a count", () => {
    render(<PatchesFleet rows={ROWS} />);
    expect(screen.getByText("Clean PC")).toBeTruthy();
    expect(screen.getByText("Needs reboot")).toBeTruthy();
    expect(screen.getByText("Never scanned")).toBeTruthy();
    expect(screen.getByText("3 of 3 computers")).toBeTruthy();
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
});
