// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ComputerDetail } from "./computer-detail";
import type {
  Asset,
  AssignmentEvent,
  InstalledSoftwareItem,
  MachineSummary,
} from "@/lib/data";

/**
 * Smoke/regression tests for the tabbed computer detail (spec 17.04, AC-4.2/4.3):
 * the five tabs render and each tab surfaces its existing content (live scan health,
 * tracked software, assignment history) under the new layout. Boundary modules (the
 * server actions, router, toast) are mocked so the component loads under jsdom.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/app/(app)/assets/actions", () => ({
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
}));
vi.mock("@/app/(app)/scan-actions", () => ({ requestScan: vi.fn() }));
vi.mock("@/app/(app)/printer-install-actions", () => ({
  installPrinterAction: vi.fn(),
  cancelInstallJobAction: vi.fn(),
}));
vi.mock("@/app/(app)/people-actions", () => ({
  assignAssetAction: vi.fn(),
  returnAssetAction: vi.fn(),
}));
vi.mock("@/app/(app)/media-actions", () => ({ setAssetImage: vi.fn() }));

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "OPUS-COMP-7491",
    name: "Sarah's Laptop",
    type: "Computer",
    serial: "C02DW480MD6R",
    model: "Dell Latitude 5520",
    assignee: { name: "Sarah Jenkins", initials: "SJ" },
    location: "SF / HQ",
    locationId: null,
    status: "deployed",
    lastSync: "2026-09-01",
    vendor: "Dell",
    purchaseDate: "2024-02-13",
    warrantyUntil: "2027-02-13",
    costCenter: "ENG-SF",
    spec: "32GB / 1TB",
    ...overrides,
  };
}

const machine: MachineSummary = {
  lastSeen: "2026-09-01",
  osName: "Windows 11 Pro",
  osVersion: "10.0.22631",
  cpu: "Intel i7-1185G7",
  ramGb: 32,
  freeDiskGb: 420,
  uptimeHours: 72,
  loggedOnUser: "AWINYC\\ibrown",
  networkAdapters: [
    { name: "Ethernet", mac: "50-9A-4C-4B-F3-DE", status: "Up", ips: ["192.168.70.160"] },
  ],
  loggedOnUsers: ["esmith"],
  status: "ok",
};

const software: InstalledSoftwareItem[] = [
  { name: "Google Chrome", version: "128.0", publisher: "Google LLC" },
];

const history: AssignmentEvent[] = [
  {
    id: "a1",
    assetId: "OPUS-COMP-7491",
    assetName: "Sarah's Laptop",
    assetType: "Computer",
    personId: "p1",
    personName: "Sarah Jenkins",
    assignedAt: "2026-02-13T10:00:00Z",
    assignedBy: "admin@opus.local",
    unassignedAt: null,
    unassignedBy: null,
    open: true,
  },
];

beforeEach(() => vi.clearAllMocks());

function renderDetail() {
  return render(
    <ComputerDetail
      asset={makeAsset()}
      machine={machine}
      software={software}
      assignmentHistory={history}
      canWrite
      canScan
    />,
  );
}

describe("ComputerDetail — tabs + content (AC-4.2, AC-4.3)", () => {
  it("renders all tabs", () => {
    renderDetail();
    for (const name of [
      "Overview",
      "Live scan",
      "Software",
      "Compliance",
      "Printers",
      "Assignment",
      "Activity",
    ]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  it("Overview leads with Asset Information and the model", () => {
    renderDetail();
    expect(screen.getByText("Asset Information")).toBeInTheDocument();
    expect(screen.getAllByText("Dell Latitude 5520").length).toBeGreaterThan(0);
  });

  it("Overview shows the logged-in user from the live scan", () => {
    renderDetail();
    expect(screen.getByText("Logged in User")).toBeInTheDocument();
    expect(screen.getByText("AWINYC\\ibrown")).toBeInTheDocument();
  });

  it("Live scan tab shows collected health", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Live scan" }));
    expect(screen.getByText("Intel i7-1185G7")).toBeInTheDocument();
    expect(screen.getByText("32 GB")).toBeInTheDocument();
  });

  it("Live scan tab shows network adapters and active sessions", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Live scan" }));
    expect(screen.getByText("Network & sessions")).toBeInTheDocument();
    expect(screen.getByText("Ethernet")).toBeInTheDocument();
    expect(screen.getByText(/50-9A-4C-4B-F3-DE/)).toBeInTheDocument();
    expect(screen.getByText("esmith")).toBeInTheDocument();
  });

  it("Software tab lists tracked software", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Software" }));
    expect(screen.getByText("Google Chrome")).toBeInTheDocument();
  });

  it("Assignment tab shows the current holder in history", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Assignment" }));
    expect(screen.getByText("Assignment History")).toBeInTheDocument();
    expect(screen.getByText("Currently held")).toBeInTheDocument();
  });
});
