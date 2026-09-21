import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ColumnPickerDialog } from "./column-picker-dialog";
import { defaultsFor } from "@/lib/table-columns";

/**
 * Component tests for the column picker (spec 11). The Server Actions are the
 * boundary, so they are mocked; the dialog's real behavior is exercised via user
 * events. Covers AC-4 (the catalog, locked Name/Actions, toggle, reorder) and
 * AC-5 (Save calls the save action with the chosen ids; Reset calls the reset
 * action; both close and toast on success).
 */

const { saveMock, resetMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  resetMock: vi.fn(),
}));

vi.mock("@/app/(app)/columns-actions", () => ({
  saveColumnConfig: saveMock,
  resetColumnConfig: resetMock,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { toast } from "sonner";

const printerDefaults = defaultsFor("printer");

function renderPicker(onOpenChange = vi.fn()) {
  render(
    <ColumnPickerDialog
      open
      onOpenChange={onOpenChange}
      view="printer"
      current={printerDefaults}
    />,
  );
  return onOpenChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue({ ok: true, message: "saved" });
  resetMock.mockResolvedValue({ ok: true, message: "reset" });
});

describe("ColumnPickerDialog — rendering (AC-3, AC-4)", () => {
  it("lists the printer catalog, including the not-yet-shown Assigned To column", () => {
    renderPicker();

    expect(screen.getByText("Configure columns")).toBeInTheDocument();
    expect(screen.getByText("IP Address")).toBeInTheDocument();
    expect(screen.getByText("Serial Number")).toBeInTheDocument();
    // Assigned To is in the printer catalog but not shown by default; it appears
    // as an available (unchecked) row.
    expect(screen.getByText("Assigned To")).toBeInTheDocument();
  });

  it("locks Asset Name and Actions so they cannot be toggled off (AC-4)", () => {
    renderPicker();

    expect(
      screen.getByRole("button", { name: /Hide Asset Name/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Hide Actions/i })).toBeDisabled();
    // Two locked rows, each with a "Locked" tag.
    expect(screen.getAllByText("Locked")).toHaveLength(2);
  });
});

describe("ColumnPickerDialog — save (AC-5)", () => {
  it("saves the current visible ids for the view, then closes and toasts", async () => {
    const user = userEvent.setup();
    const onOpenChange = renderPicker();

    await user.click(screen.getByRole("button", { name: /Save for everyone/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith("printer", printerDefaults);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("saved");
  });

  it("includes a newly enabled column in the saved ids", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /Show Assigned To/i }));
    await user.click(screen.getByRole("button", { name: /Save for everyone/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const savedIds = saveMock.mock.calls[0][1] as string[];
    expect(savedIds).toContain("assignee");
  });

  it("drops a disabled column from the saved ids", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /Hide Serial Number/i }));
    await user.click(screen.getByRole("button", { name: /Save for everyone/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const savedIds = saveMock.mock.calls[0][1] as string[];
    expect(savedIds).not.toContain("serial");
  });

  it("reflects a reorder in the saved id order (AC-4)", async () => {
    const user = userEvent.setup();
    renderPicker();

    // Default order has Model before Serial Number; move Serial up past Model.
    await user.click(screen.getByRole("button", { name: /Move Serial Number up/i }));
    await user.click(screen.getByRole("button", { name: /Save for everyone/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const savedIds = saveMock.mock.calls[0][1] as string[];
    expect(savedIds.indexOf("serial")).toBeLessThan(savedIds.indexOf("model"));
  });
});

describe("ColumnPickerDialog — reset (AC-5)", () => {
  it("resets the view to defaults, then closes and toasts", async () => {
    const user = userEvent.setup();
    const onOpenChange = renderPicker();

    await user.click(screen.getByRole("button", { name: /Reset to defaults/i }));

    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1));
    expect(resetMock).toHaveBeenCalledWith("printer");
    expect(saveMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("reset");
  });
});
