import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DiscoveryToggles } from "./discovery-toggles";

/**
 * Component tests for the Admin Discovery switches (spec 13). The server action
 * and sonner are mocked. Locks in AC-1 (render the saved state, a toggle calls
 * the action, optimistic update with revert on failure) and AC-7 (read only
 * without scan:write).
 */

const { actionMock, toastSuccess, toastError } = vi.hoisted(() => ({
  actionMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/app/(app)/discovery-actions", () => ({
  setDiscoveryToggleAction: actionMock,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: toastSuccess, error: toastError }),
}));

const bothOn = { computer: true, printer: true };

beforeEach(() => vi.clearAllMocks());

describe("DiscoveryToggles — render (AC-1)", () => {
  it("renders a switch per type reflecting the saved state", () => {
    render(
      <DiscoveryToggles
        settings={{ computer: true, printer: false }}
        canWrite
      />,
    );
    expect(screen.getByRole("switch", { name: /Computers/i })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Printers/i })).not.toBeChecked();
  });
});

describe("DiscoveryToggles — read only without scan:write (AC-7)", () => {
  it("disables both switches", () => {
    render(<DiscoveryToggles settings={bothOn} canWrite={false} />);
    // Base UI renders the switch as a span with aria-disabled, not a native
    // disabled control, so assert the ARIA state.
    expect(
      screen.getByRole("switch", { name: /Computers/i }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("switch", { name: /Printers/i }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});

describe("DiscoveryToggles — toggle (AC-1)", () => {
  it("calls the action with the flipped value and shows success", async () => {
    actionMock.mockResolvedValue({ ok: true, message: "ok" });
    const user = userEvent.setup();
    render(<DiscoveryToggles settings={bothOn} canWrite />);

    await user.click(screen.getByRole("switch", { name: /Computers/i }));

    expect(actionMock).toHaveBeenCalledWith("computer", false);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(screen.getByRole("switch", { name: /Computers/i })).not.toBeChecked();
  });

  it("reverts the switch and shows an error when the action fails", async () => {
    actionMock.mockResolvedValue({ ok: false, error: "nope" });
    const user = userEvent.setup();
    render(<DiscoveryToggles settings={bothOn} canWrite />);

    await user.click(screen.getByRole("switch", { name: /Computers/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("nope"));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /Computers/i })).toBeChecked(),
    );
  });
});
