// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThinAssetDetail } from "./thin-detail";
import type { Asset } from "@/lib/data";

/**
 * Smoke/regression tests for the thin-category tabbed detail (spec 17.05): Monitors/
 * Phones get Overview/Assignment/Activity; Network gets Overview/Network/Activity.
 * Each tab surfaces its existing content (spec-10 fields, assignment) under the shared
 * framework. Boundary modules mocked so it loads under jsdom.
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
vi.mock("@/app/(app)/people-actions", () => ({
  assignAssetAction: vi.fn(),
  returnAssetAction: vi.fn(),
}));
vi.mock("@/app/(app)/media-actions", () => ({ setAssetImage: vi.fn() }));

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "OPUS-MON-1",
    name: "Dell U2722DE",
    type: "Monitor",
    serial: "CN-123",
    model: "Dell U2722DE",
    assignee: { name: "Sarah Jenkins", initials: "SJ" },
    location: "SF / HQ",
    locationId: null,
    status: "deployed",
    lastSync: "2026-09-01",
    vendor: "Dell",
    purchaseDate: "2024-02-13",
    warrantyUntil: "2027-02-13",
    costCenter: "ENG-SF",
    spec: "",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("ThinAssetDetail — Monitor (AC-5.2, AC-5.3)", () => {
  it("has Overview / Assignment / Activity tabs, no Network tab", () => {
    render(
      <ThinAssetDetail
        asset={makeAsset()}
        details={{ resolution: "3840x2160", panelType: "IPS" }}
        canWrite
      />,
    );
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Assignment" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Network" })).toBeNull();
  });

  it("Overview shows Asset Information and the spec-10 fields", () => {
    render(
      <ThinAssetDetail
        asset={makeAsset()}
        details={{ resolution: "3840x2160", panelType: "IPS" }}
        canWrite
      />,
    );
    expect(screen.getByText("Asset Information")).toBeInTheDocument();
    expect(screen.getByText("Monitor Details")).toBeInTheDocument();
    expect(screen.getByText("3840x2160")).toBeInTheDocument();
  });

  it("Assignment tab shows the history", async () => {
    const user = userEvent.setup();
    render(
      <ThinAssetDetail
        asset={makeAsset()}
        details={null}
        canWrite
        assignmentHistory={[
          {
            id: "a1",
            assetId: "OPUS-MON-1",
            assetName: "Dell U2722DE",
            assetType: "Monitor",
            personId: "p1",
            personName: "Sarah Jenkins",
            assignedAt: "2026-02-13T10:00:00Z",
            assignedBy: "admin@opus.local",
            unassignedAt: null,
            unassignedBy: null,
            open: true,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Assignment" }));
    expect(screen.getByText("Assignment History")).toBeInTheDocument();
    expect(screen.getByText("Currently held")).toBeInTheDocument();
  });
});

describe("ThinAssetDetail — Network (AC-5.2, AC-5.3)", () => {
  it("has Overview / Network / Activity tabs, no Assignment tab", async () => {
    const user = userEvent.setup();
    render(
      <ThinAssetDetail
        asset={makeAsset({
          id: "OPUS-NET-1",
          name: "Core Switch",
          type: "Network",
          assignee: null,
        })}
        details={{ ipAddress: "192.168.70.1", deviceRole: "switch" }}
        canWrite
      />,
    );
    expect(screen.getByRole("tab", { name: "Network" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Assignment" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Network" }));
    expect(screen.getByText("192.168.70.1")).toBeInTheDocument();
  });
});
