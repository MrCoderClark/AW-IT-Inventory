import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AssetFormDialog, type PersonOption } from "./asset-form-dialog";
import type { AssetFormValues } from "@/lib/asset-schema";

// Boundary mocks: the server-action module (server-only + db client under the
// hood) and an inert sonner toast.
vi.mock("@/app/(app)/assets/actions", () => ({
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { createAsset, updateAsset } from "@/app/(app)/assets/actions";

const people: PersonOption[] = [
  { id: "550e8400-e29b-41d4-a716-446655440000", name: "Alice Stone" },
];

const filledValues: AssetFormValues = {
  name: "Bay 3 Monitor",
  type: "Monitor",
  status: "storage",
  serial: "SN-123",
  model: "Dell U2723",
  assigneeId: "",
  location: "SF — HQ",
  vendor: "Dell",
  spec: "4K",
  costCenter: "ENG",
  purchaseDate: "2024-06-01",
  warrantyUntil: "2027-06-01",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AssetFormDialog — create mode", () => {
  // covers: AC-1 (type pre-selected from the category page)
  it("pre-selects the category type and titles the dialog New asset", () => {
    render(
      <AssetFormDialog
        open
        onOpenChange={vi.fn()}
        mode="create"
        people={people}
        presetType="Monitor"
      />,
    );

    expect(screen.getByText("New asset")).toBeInTheDocument();
    // The Type trigger shows the pre-selected value.
    expect(screen.getByText("Monitor")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Create asset/i }),
    ).toBeInTheDocument();
  });

  // covers: AC-4 (client-side inline validation, no write on invalid submit)
  it("shows a required-field error and does not call the action on a blank submit", async () => {
    const user = userEvent.setup();
    render(
      <AssetFormDialog
        open
        onOpenChange={vi.fn()}
        mode="create"
        people={people}
        presetType="Monitor"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Create asset/i }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(createAsset).not.toHaveBeenCalled();
  });

  // covers: AC-2 (assignee options: unassigned + existing people, no write yet)
  it("renders without an assignee pre-selected", () => {
    render(
      <AssetFormDialog
        open
        onOpenChange={vi.fn()}
        mode="create"
        people={people}
        presetType="Monitor"
      />,
    );
    expect(screen.getByText("Available (unassigned)")).toBeInTheDocument();
  });
});

describe("AssetFormDialog — edit mode", () => {
  // covers: AC-3 (tag and type are read-only on edit)
  it("shows the tag as a read-only value and locks the type", () => {
    render(
      <AssetFormDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        people={people}
        editTag="OPUS-MON-ABC12"
        initial={filledValues}
      />,
    );

    expect(screen.getByText("Edit asset")).toBeInTheDocument();
    const tagInput = screen.getByDisplayValue("OPUS-MON-ABC12");
    expect(tagInput).toBeDisabled();
    // The locked-type affordance is present.
    expect(screen.getByText(/Type \(locked\)/i)).toBeInTheDocument();
    expect(
      screen.getByText(/delete and re-create to change/i),
    ).toBeInTheDocument();
  });

  // covers: AC-3 (the form is pre-filled from the asset's current values)
  it("pre-fills the form fields from initial values", () => {
    render(
      <AssetFormDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        people={people}
        editTag="OPUS-MON-ABC12"
        initial={filledValues}
      />,
    );
    expect(screen.getByDisplayValue("Bay 3 Monitor")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Dell U2723")).toBeInTheDocument();
  });

  // covers: AC-3 (saving a valid edit calls updateAsset with the tag + values,
  // then closes the dialog)
  it("calls updateAsset with the tag and closes on success", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    vi.mocked(updateAsset).mockResolvedValue({
      ok: true,
      message: "Asset updated.",
    });

    render(
      <AssetFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        people={people}
        editTag="OPUS-MON-ABC12"
        initial={filledValues}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith(
        "OPUS-MON-ABC12",
        expect.objectContaining({ name: "Bay 3 Monitor", type: "Monitor" }),
      ),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // covers: AC-6 (a failed action shows an error and keeps the dialog open)
  it("keeps the dialog open and does not close when the action is forbidden", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    vi.mocked(updateAsset).mockResolvedValue({
      ok: false,
      error: "You don't have permission to do that.",
    });

    render(
      <AssetFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        people={people}
        editTag="OPUS-MON-ABC12"
        initial={filledValues}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => expect(updateAsset).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
