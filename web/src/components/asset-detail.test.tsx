import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AssetDetail } from "./asset-detail";
import type { Asset, MachineSummary } from "@/lib/data";

// Boundary mocks: a stub router for the back button, an inert sonner toast,
// and the server-action module (importing it for real would pull in
// `server-only` + the db client, which don't load under jsdom).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/app/(app)/assets/actions", () => ({
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
}));

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "OPUS-COMP-7491",
    name: 'Sarah\'s MacBook Pro 16"',
    type: "Computer",
    serial: "C02DW480MD6R",
    model: 'MacBook Pro 16" (M3 Max)',
    assignee: { name: "Sarah Jenkins", initials: "SJ" },
    location: "SF / HQ / L4",
    locationId: null,
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "Apple Enterprise",
    purchaseDate: "2024-02-13",
    warrantyUntil: "2027-02-13",
    costCenter: "ENG-CORE-SF",
    spec: "64GB RAM / 2TB SSD",
    ...overrides,
  };
}

const machine: MachineSummary = {
  lastSeen: "2026-08-26",
  osName: "Windows 10 Pro",
  osVersion: "10.0.19045",
  cpu: "i7-4770S",
  ramGb: 16,
  freeDiskGb: null,
  uptimeHours: null,
  status: "ok",
};

describe("AssetDetail", () => {
  // covers: AC-4 (header: type, name, copyable id, status)
  it("renders the header with type, name, asset id, and status", () => {
    render(<AssetDetail asset={makeAsset()} />);

    expect(screen.getByText("Computer")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: 'Sarah\'s MacBook Pro 16"' }),
    ).toBeInTheDocument();
    expect(screen.getByText("OPUS-COMP-7491")).toBeInTheDocument();
    expect(screen.getByText("Deployed")).toBeInTheDocument();
  });

  // covers: AC-4 (metadata grid)
  it("renders every metadata field and its value", () => {
    render(<AssetDetail asset={makeAsset()} />);

    for (const label of [
      "Model",
      "Specification",
      "Assigned To",
      "Location",
      "Purchase Date",
      "Warranty Until",
      "Vendor",
      "Cost Center",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('MacBook Pro 16" (M3 Max)')).toBeInTheDocument();
    expect(screen.getByText("64GB RAM / 2TB SSD")).toBeInTheDocument();
    expect(screen.getByText("Sarah Jenkins")).toBeInTheDocument();
    expect(screen.getByText("Apple Enterprise")).toBeInTheDocument();
  });

  // covers: AC-4 (missing dates show a placeholder, never "Invalid Date")
  it("renders a placeholder for empty purchase/warranty dates", () => {
    render(
      <AssetDetail
        asset={makeAsset({ purchaseDate: "", warrantyUntil: "" })}
      />,
    );
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  // covers: AC-4 (assignee falls back to a clear placeholder)
  it("shows an available label when no one is assigned", () => {
    render(<AssetDetail asset={makeAsset({ assignee: null })} />);
    expect(screen.getByText("— Available")).toBeInTheDocument();
  });

  // covers: AC-4 (live-scan panel with collector data)
  it("renders the live scan panel with machine data when present", () => {
    render(<AssetDetail asset={makeAsset()} machine={machine} />);

    expect(screen.getByText(/Live scan/)).toBeInTheDocument();
    expect(screen.getByText("Windows 10 Pro 10.0.19045")).toBeInTheDocument();
    expect(screen.getByText("i7-4770S")).toBeInTheDocument();
    expect(screen.getByText("16 GB")).toBeInTheDocument();
  });

  // covers: AC-4 (live-scan shows for a Computer even with no scan yet)
  it("shows a no-scan-data message for a Computer without machine data", () => {
    render(<AssetDetail asset={makeAsset()} />);
    expect(screen.getByText(/No scan data yet/)).toBeInTheDocument();
  });

  // covers: AC-4 (live-scan is hidden when it does not apply)
  it("hides the live scan panel for a Monitor with no machine data", () => {
    render(<AssetDetail asset={makeAsset({ type: "Monitor" })} />);
    expect(screen.queryByText(/Live scan/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No scan data yet/)).not.toBeInTheDocument();
  });

  // covers: AC-4 (live-scan shows for any asset once machine data exists)
  it("renders the live scan panel for a Monitor when machine data exists", () => {
    render(<AssetDetail asset={makeAsset({ type: "Monitor" })} machine={machine} />);
    expect(screen.getByText(/Live scan/)).toBeInTheDocument();
  });

  // covers: AC-4 (audit timeline)
  it("renders the audit history timeline", () => {
    render(<AssetDetail asset={makeAsset()} />);
    expect(screen.getByText("Audit History")).toBeInTheDocument();
    expect(screen.getByText("Assigned to Sarah Jenkins")).toBeInTheDocument();
  });

  // covers: AC-6 (a read-only user sees no write controls)
  it("hides the Edit and Delete controls without asset:write", () => {
    render(<AssetDetail asset={makeAsset()} />);
    expect(
      screen.getByRole("button", { name: /Back to inventory/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Print label/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete asset/i })).toBeNull();
  });

  // covers: AC-3, AC-5, AC-6 (a writer sees Edit + Delete controls)
  it("shows the Edit and Delete controls with asset:write", () => {
    render(<AssetDetail asset={makeAsset()} canWrite />);
    expect(screen.getByRole("button", { name: /Edit/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Delete asset/i }),
    ).toBeInTheDocument();
  });
});
