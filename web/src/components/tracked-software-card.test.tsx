// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TrackedSoftwareCard } from "./tracked-software-card";

/**
 * Component tests for the Admin tracked-software card (spec 15). The server
 * actions and sonner are mocked; the DOM behavior runs for real. Locks in AC-1
 * (render the list, add a title, remove a title) plus the empty state and the
 * icon-button accessible name.
 */

const { addMock, removeMock, toastSuccess, toastError } = vi.hoisted(() => ({
  addMock: vi.fn(),
  removeMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/app/(app)/software-actions", () => ({
  addTrackedSoftwareAction: addMock,
  removeTrackedSoftwareAction: removeMock,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: toastSuccess, error: toastError }),
}));
// The icon-upload control (rendered per row) pulls in the router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const titles = [
  { id: "t1", name: "Google Chrome", iconUrl: null, hasCustomIcon: false },
  { id: "t2", name: "7-Zip", iconUrl: "/api/software/t2/icon", hasCustomIcon: true },
];

beforeEach(() => vi.clearAllMocks());

describe("TrackedSoftwareCard — render (AC-1)", () => {
  it("lists each tracked title with a labelled remove button", () => {
    render(<TrackedSoftwareCard titles={titles} />);
    expect(screen.getByText("Google Chrome")).toBeInTheDocument();
    expect(screen.getByText("7-Zip")).toBeInTheDocument();
    // Icon-only remove buttons expose an accessible name per title (a11y).
    expect(
      screen.getByRole("button", { name: /Stop tracking Google Chrome/i }),
    ).toBeInTheDocument();
  });

  it("shows an empty state when nothing is tracked", () => {
    render(<TrackedSoftwareCard titles={[]} />);
    expect(screen.getByText(/No titles tracked yet/i)).toBeInTheDocument();
  });

  it("disables Add until a title is typed", async () => {
    const user = userEvent.setup();
    render(<TrackedSoftwareCard titles={[]} />);
    const add = screen.getByRole("button", { name: /^Add$/i });
    expect(add).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: /Software title to track/i }),
      "Slack",
    );
    expect(add).toBeEnabled();
  });
});

describe("TrackedSoftwareCard — add (AC-1)", () => {
  it("calls the action with the typed title, toasts success, and clears the input", async () => {
    addMock.mockResolvedValue({ ok: true, message: "Now tracking \"Slack\"." });
    const user = userEvent.setup();
    render(<TrackedSoftwareCard titles={[]} />);

    const input = screen.getByRole("textbox", { name: /Software title to track/i });
    await user.type(input, "Slack");
    await user.click(screen.getByRole("button", { name: /^Add$/i }));

    expect(addMock).toHaveBeenCalledWith("Slack");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("toasts the error and keeps the input on a failed add", async () => {
    addMock.mockResolvedValue({ ok: false, error: "\"slack\" is already tracked." });
    const user = userEvent.setup();
    render(<TrackedSoftwareCard titles={[]} />);

    const input = screen.getByRole("textbox", { name: /Software title to track/i });
    await user.type(input, "slack");
    await user.click(screen.getByRole("button", { name: /^Add$/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("\"slack\" is already tracked."),
    );
    expect(input).toHaveValue("slack");
  });
});

describe("TrackedSoftwareCard — remove (AC-1)", () => {
  it("calls the remove action with the title id and toasts success", async () => {
    removeMock.mockResolvedValue({ ok: true, message: "Stopped tracking that title." });
    const user = userEvent.setup();
    render(<TrackedSoftwareCard titles={titles} />);

    await user.click(
      screen.getByRole("button", { name: /Stop tracking 7-Zip/i }),
    );

    expect(removeMock).toHaveBeenCalledWith("t2");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });
});
