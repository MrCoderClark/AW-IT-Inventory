import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PersonDetail } from "./person-detail";
import type {
  AssignmentEvent,
  CurrentDevice,
  DirectoryPerson,
} from "@/lib/data";

/**
 * Component tests for the person detail page (spec 16). The server actions,
 * sonner, the router, and the form dialog are mocked; the real gating and DOM
 * behavior run. Traces:
 *   AC-4  profile + current devices + history render
 *   AC-6  Return calls returnAssetAction with the device tag
 *   AC-8  an archived person shows Restore (not Archive) and no assign control
 *   AC-9  Delete shows only when the person has no history
 *   AC-10 a read-only viewer sees no write controls but can still view
 */

const M = vi.hoisted(() => ({
  assignMock: vi.fn(),
  returnMock: vi.fn(),
  archiveMock: vi.fn(),
  restoreMock: vi.fn(),
  deleteMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/app/(app)/people-actions", () => ({
  assignAssetAction: M.assignMock,
  returnAssetAction: M.returnMock,
  archivePersonAction: M.archiveMock,
  restorePersonAction: M.restoreMock,
  deletePersonAction: M.deleteMock,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: M.toastSuccess, error: M.toastError }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: M.refresh, push: M.push }),
}));
vi.mock("./person-form-dialog", () => ({ PersonFormDialog: () => null }));

function makePerson(overrides: Partial<DirectoryPerson> = {}): DirectoryPerson {
  return {
    id: "person-1",
    name: "Verify Person",
    initials: "VP",
    email: "verify@qa.local",
    department: "QA",
    jobTitle: "Tester",
    phone: "",
    employeeId: "EMP-1",
    officeLocation: "",
    officeLocationId: null,
    status: "active",
    deviceCount: 1,
    ...overrides,
  };
}

const device: CurrentDevice = {
  id: "OPUS-PHN-7495",
  name: "Field iPhone",
  type: "Phone",
  serial: "SN-1",
  assignedAt: "2026-09-29T15:14:00Z",
};

const openEvent: AssignmentEvent = {
  id: "e1",
  assetId: "OPUS-PHN-7495",
  assetName: "Field iPhone",
  assetType: "Phone",
  personId: "person-1",
  personName: "Verify Person",
  assignedAt: "2026-09-29T15:14:00Z",
  assignedBy: "admin@x",
  unassignedAt: null,
  unassignedBy: null,
  open: true,
};

beforeEach(() => vi.clearAllMocks());

describe("PersonDetail — render (AC-4)", () => {
  it("shows the profile, current devices, and history", () => {
    render(
      <PersonDetail
        person={makePerson()}
        currentDevices={[device]}
        history={[openEvent]}
        canWrite
      />,
    );
    expect(screen.getByRole("heading", { name: /Verify Person/ })).toBeInTheDocument();
    expect(screen.getByText("verify@qa.local")).toBeInTheDocument();
    expect(screen.getByText("Current devices (1)")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Field iPhone" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Currently held/i)).toBeInTheDocument();
  });

  it("shows empty states for a person with no devices or history", () => {
    render(
      <PersonDetail person={makePerson({ deviceCount: 0 })} currentDevices={[]} history={[]} canWrite />,
    );
    expect(screen.getByText(/No devices assigned right now/i)).toBeInTheDocument();
    expect(screen.getByText(/No assignment history yet/i)).toBeInTheDocument();
  });
});

describe("PersonDetail — write gate (AC-10)", () => {
  it("hides every write control for a read-only viewer but still shows the data", () => {
    render(
      <PersonDetail
        person={makePerson()}
        currentDevices={[device]}
        history={[openEvent]}
        canWrite={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Archive/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete person/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Return/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Assign$/i })).toBeNull();
    // Viewing stays open: the device link is still there.
    expect(screen.getAllByRole("link", { name: "Field iPhone" }).length).toBeGreaterThan(0);
  });
});

describe("PersonDetail — delete gating (AC-9)", () => {
  it("offers Delete for a person with no history", () => {
    render(<PersonDetail person={makePerson({ deviceCount: 0 })} currentDevices={[]} history={[]} canWrite />);
    expect(screen.getByRole("button", { name: /Delete person/i })).toBeInTheDocument();
  });

  it("hides Delete once the person has any history", () => {
    render(<PersonDetail person={makePerson()} currentDevices={[device]} history={[openEvent]} canWrite />);
    expect(screen.queryByRole("button", { name: /Delete person/i })).toBeNull();
  });
});

describe("PersonDetail — archived (AC-8)", () => {
  it("shows Restore (not Archive) and no assign control for an archived person", () => {
    render(
      <PersonDetail
        person={makePerson({ status: "archived", deviceCount: 0 })}
        currentDevices={[]}
        history={[openEvent]}
        canWrite
      />,
    );
    expect(screen.getByRole("button", { name: /Restore/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archive/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Assign$/i })).toBeNull();
  });
});

describe("PersonDetail — return a device (AC-6)", () => {
  it("calls returnAssetAction with the device tag and toasts success", async () => {
    M.returnMock.mockResolvedValue({ ok: true, message: "Device returned to the pool." });
    const user = userEvent.setup();
    render(<PersonDetail person={makePerson()} currentDevices={[device]} history={[openEvent]} canWrite />);

    await user.click(screen.getByRole("button", { name: /Return/i }));

    expect(M.returnMock).toHaveBeenCalledWith("OPUS-PHN-7495");
    await waitFor(() => expect(M.toastSuccess).toHaveBeenCalled());
  });
});

describe("PersonDetail — archive confirm (AC-8)", () => {
  it("opens a confirmation naming the person before archiving", async () => {
    const user = userEvent.setup();
    render(<PersonDetail person={makePerson()} currentDevices={[device]} history={[openEvent]} canWrite />);

    await user.click(screen.getByRole("button", { name: /Archive/i }));
    expect(await screen.findByText(/Archive Verify Person\?/i)).toBeInTheDocument();
    // Not archived until the dialog is confirmed.
    expect(M.archiveMock).not.toHaveBeenCalled();
  });
});
