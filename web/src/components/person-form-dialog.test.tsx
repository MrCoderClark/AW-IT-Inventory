// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PersonFormDialog } from "./person-form-dialog";
import { EMPTY_PERSON_FORM } from "@/lib/person-schema";

/**
 * Component tests for the person create/edit dialog (spec 16). The server actions
 * and sonner are mocked; the real zod validation and DOM behavior run. Traces:
 *   AC-1 name is required (inline error, no action call); a valid submit routes to
 *        create or update; fields are labelled (a11y)
 */

const { createMock, updateMock, toastSuccess, toastError } = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/app/(app)/people-actions", () => ({
  createPersonAction: createMock,
  updatePersonAction: updateMock,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: toastSuccess, error: toastError }),
}));

beforeEach(() => vi.clearAllMocks());

describe("PersonFormDialog — create (AC-1)", () => {
  it("labels the name and email fields (a11y)", () => {
    render(<PersonFormDialog open mode="create" onOpenChange={() => {}} />);
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
  });

  it("blocks submit and shows an inline error when the name is empty", async () => {
    const user = userEvent.setup();
    render(<PersonFormDialog open mode="create" onOpenChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Add person/i }));
    // Exact match: the dialog description also contains "a name is required".
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("submits a valid person through createPersonAction and toasts success", async () => {
    createMock.mockResolvedValue({ ok: true, message: "Added Grace Park." });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<PersonFormDialog open mode="create" onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText(/Name/), "Grace Park");
    await user.click(screen.getByRole("button", { name: /Add person/i }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Grace Park" }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("toasts the error and stays open on a failed create", async () => {
    createMock.mockResolvedValue({ ok: false, error: "That email is already used by someone else." });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<PersonFormDialog open mode="create" onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText(/Name/), "Dup");
    await user.click(screen.getByRole("button", { name: /Add person/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "That email is already used by someone else.",
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("PersonFormDialog — edit (AC-1)", () => {
  it("routes a valid edit through updatePersonAction with the person id", async () => {
    updateMock.mockResolvedValue({ ok: true, message: "Person updated." });
    const user = userEvent.setup();
    render(
      <PersonFormDialog
        open
        mode="edit"
        editId="person-9"
        initial={{ ...EMPTY_PERSON_FORM, name: "Old Name" }}
        onOpenChange={() => {}}
      />,
    );

    const name = screen.getByLabelText(/Name/);
    await user.clear(name);
    await user.type(name, "New Name");
    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    expect(updateMock).toHaveBeenCalledWith(
      "person-9",
      expect.objectContaining({ name: "New Name" }),
    );
  });
});
