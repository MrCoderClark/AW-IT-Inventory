// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AlertRulesTable } from "./alert-rules-table";
import type { AlertRuleRecord } from "@/lib/alert-rules";

/**
 * Admin alert-rules table (spec 30, AC-1). Actions and sonner are mocked;
 * the table, enable switch, and New/Edit/Delete controls run for real.
 */

const { setEnabledMock, deleteMock, toastSuccess, toastError, refreshMock } =
  vi.hoisted(() => ({
    setEnabledMock: vi.fn(),
    deleteMock: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    refreshMock: vi.fn(),
  }));

vi.mock("@/app/(app)/alert-rule-actions", () => ({
  setAlertRuleEnabledAction: setEnabledMock,
  deleteAlertRuleAction: deleteMock,
  createAlertRuleAction: vi.fn(),
  updateAlertRuleAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: toastSuccess, error: toastError }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const SCRIPTS = [
  { id: "s3000000-0000-4000-8000-000000000001", name: "Clear temp" },
];

const GROUPS = [
  { id: "g3000000-0000-4000-8000-000000000001", name: "Win11 lab" },
];

const RULES: AlertRuleRecord[] = [
  {
    id: "a3000000-0000-4000-8000-000000000001",
    name: "CPU high",
    signal: "cpu_pct",
    op: "gte",
    threshold: 90,
    consecutive: 2,
    severity: "warning",
    enabled: true,
    ticketAutoCreate: "inherit",
    remediationScriptId: null,
    remediationScriptName: null,
    deviceGroupId: null,
    deviceGroupName: null,
  },
  {
    id: "a3000000-0000-4000-8000-000000000003",
    name: "Disk almost full",
    signal: "disk_pct",
    op: "gte",
    threshold: 90,
    consecutive: 1,
    severity: "critical",
    enabled: true,
    ticketAutoCreate: "inherit",
    remediationScriptId: SCRIPTS[0].id,
    remediationScriptName: "Clear temp",
    deviceGroupId: GROUPS[0].id,
    deviceGroupName: "Win11 lab",
  },
];

beforeEach(() => vi.clearAllMocks());

describe("AlertRulesTable — render (AC-1, AC-8)", () => {
  it("lists each rule with a readable condition and labelled controls", () => {
    render(
      <AlertRulesTable rules={RULES} scripts={SCRIPTS} groups={GROUPS} />,
    );
    expect(screen.getByText("CPU high")).toBeInTheDocument();
    expect(
      screen.getByText("CPU ≥ 90% for 2 samples (~30 min)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Disk ≥ 90% for 1 sample (~15 min)"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Edit CPU high/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Delete Disk almost full/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /Disable CPU high/i }),
    ).toBeChecked();
    expect(screen.getAllByText("Inherit")).toHaveLength(2);
    expect(screen.getByText("Clear temp")).toBeInTheDocument();
    expect(screen.getByText("On fire")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Win11 lab")).toBeInTheDocument();
  });

  it("shows empty copy when there are no rules", () => {
    render(<AlertRulesTable rules={[]} scripts={[]} groups={[]} />);
    expect(screen.getByText(/No alert rules yet/i)).toBeInTheDocument();
  });
});

describe("AlertRulesTable — enable / delete (AC-1)", () => {
  it("calls the enable action with the flipped value", async () => {
    setEnabledMock.mockResolvedValue({
      ok: true,
      message: 'Disabled "CPU high".',
    });
    const user = userEvent.setup();
    render(
      <AlertRulesTable rules={RULES} scripts={SCRIPTS} groups={GROUPS} />,
    );

    await user.click(screen.getByRole("switch", { name: /Disable CPU high/i }));

    expect(setEnabledMock).toHaveBeenCalledWith(RULES[0].id, false);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it("deletes a rule", async () => {
    deleteMock.mockResolvedValue({ ok: true, message: "Deleted that rule." });
    const user = userEvent.setup();
    render(
      <AlertRulesTable rules={RULES} scripts={SCRIPTS} groups={GROUPS} />,
    );

    await user.click(
      screen.getByRole("button", { name: /Delete CPU high/i }),
    );

    expect(deleteMock).toHaveBeenCalledWith(RULES[0].id);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe("AlertRulesTable — dialog (AC-1)", () => {
  it("opens the create dialog from New rule", async () => {
    const user = userEvent.setup();
    render(
      <AlertRulesTable rules={RULES} scripts={SCRIPTS} groups={GROUPS} />,
    );
    await user.click(screen.getByRole("button", { name: /New rule/i }));
    expect(screen.getByText("New alert rule")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Create rule/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Run script on fire/i)).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByText(/^Scope$/i),
    ).toBeInTheDocument();
  });

  it("opens the edit dialog for a row", async () => {
    const user = userEvent.setup();
    render(
      <AlertRulesTable rules={RULES} scripts={SCRIPTS} groups={GROUPS} />,
    );
    await user.click(screen.getByRole("button", { name: /Edit CPU high/i }));
    expect(screen.getByText("Edit alert rule")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CPU high")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save rule/i }),
    ).toBeInTheDocument();
  });
});
