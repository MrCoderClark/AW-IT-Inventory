import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AssetTable, type AssetTableConfig } from "./asset-table";
import type { Asset } from "@/lib/data";

// Capture router.push so we can assert row navigation (AC-3).
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/computers",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
// AssetTable pulls in AssetFormDialog, which imports the server-action module
// (server-only + db client); mock it so the suite loads under jsdom.
vi.mock("@/app/(app)/assets/actions", () => ({
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
}));
// The column picker imports the columns Server Actions (server-only + db client)
// the same way; mock it so the suite loads under jsdom (spec 11).
vi.mock("@/app/(app)/columns-actions", () => ({
  saveColumnConfig: vi.fn(),
  resetColumnConfig: vi.fn(),
}));

let seq = 0;
function makeAsset(overrides: Partial<Asset> = {}): Asset {
  seq += 1;
  return {
    id: `OPUS-COMP-${7000 + seq}`,
    name: `Asset ${seq}`,
    type: "Computer",
    serial: `SER${seq}`,
    model: `Model ${seq}`,
    assignee: { name: `Person ${seq}`, initials: "PP" },
    location: "SF",
    locationId: null,
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "Vendor",
    purchaseDate: "2024-02-13",
    warrantyUntil: "2027-02-13",
    costCenter: "CC",
    spec: "spec",
    ...overrides,
  };
}

function renderTable(assets: Asset[], config: AssetTableConfig) {
  return render(<AssetTable assets={assets} config={config} />);
}

beforeEach(() => {
  pushMock.mockReset();
  seq = 0;
});

describe("AssetTable column configuration", () => {
  // covers: AC-2 (per-category column sets; type column dropped when scoped)
  it("shows the Computer columns, including Last Sync and Assigned To, without a Type column", () => {
    renderTable([makeAsset()], { type: "Computer" });
    expect(screen.getByText("Last Sync")).toBeInTheDocument();
    expect(screen.getByText("Assigned To")).toBeInTheDocument();
    expect(screen.queryByText("Type")).not.toBeInTheDocument();
  });

  // covers: AC-2 (Monitors omit Last Sync)
  it("drops the Last Sync column for Monitors", () => {
    renderTable([makeAsset({ type: "Monitor" })], { type: "Monitor" });
    expect(screen.queryByText("Last Sync")).not.toBeInTheDocument();
    expect(screen.getByText("Assigned To")).toBeInTheDocument();
  });

  // covers: AC-2 (Printers omit Assigned To, keep Last Sync)
  it("drops the Assigned To column for Printers", () => {
    renderTable([makeAsset({ type: "Printer" })], { type: "Printer" });
    expect(screen.queryByText("Assigned To")).not.toBeInTheDocument();
    expect(screen.getByText("Last Sync")).toBeInTheDocument();
  });

  // covers: AC-2 (Network omits both Assigned To and Last Sync)
  it("drops both Assigned To and Last Sync for Network gear", () => {
    renderTable([makeAsset({ type: "Network" })], { type: "Network" });
    expect(screen.queryByText("Assigned To")).not.toBeInTheDocument();
    expect(screen.queryByText("Last Sync")).not.toBeInTheDocument();
  });

  // covers: AC-8 (the all-types dashboard view keeps the Type column)
  it("includes a Type column for the all-types view", () => {
    renderTable([makeAsset()], { showTypeFilter: true });
    expect(screen.getByText("Type")).toBeInTheDocument();
  });
});

describe("AssetTable type filter visibility", () => {
  // covers: AC-2 (the redundant asset-type filter is hidden on category pages)
  it("renders only the status filter on a scoped category page", () => {
    const { container } = renderTable([makeAsset()], { type: "Computer" });
    expect(
      container.querySelectorAll('[data-slot="select-trigger"]'),
    ).toHaveLength(1);
  });

  // covers: AC-2 / AC-8 (the dashboard shows both the type and status filters)
  it("renders both the type and status filters on the all-types view", () => {
    const { container } = renderTable([makeAsset()], { showTypeFilter: true });
    expect(
      container.querySelectorAll('[data-slot="select-trigger"]'),
    ).toHaveLength(2);
  });
});

describe("AssetTable empty state", () => {
  // covers: AC-1 (an empty category shows a clear empty state)
  it("shows the configured empty message when there are no assets", () => {
    renderTable([], { type: "Monitor", emptyMessage: "No monitors yet." });
    expect(screen.getByText("No monitors yet.")).toBeInTheDocument();
  });

  // covers: AC-1 (a sensible default when no message is configured)
  it("falls back to a default empty message", () => {
    renderTable([], { type: "Monitor" });
    expect(screen.getByText("No assets yet.")).toBeInTheDocument();
  });
});

describe("AssetTable search", () => {
  // covers: AC-2 (search narrows the visible rows)
  it("filters rows to those matching the search text", async () => {
    const user = userEvent.setup();
    const assets = [
      makeAsset({ id: "OPUS-COMP-1", name: "Elena ThinkPad", model: "Lenovo X1" }),
      makeAsset({ id: "OPUS-COMP-2", name: "Sarah MacBook", model: "Apple 16" }),
      makeAsset({ id: "OPUS-COMP-3", name: "David Latitude", model: "Dell 7440" }),
    ];
    renderTable(assets, { type: "Computer" });

    expect(screen.getByText("Sarah MacBook")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/Search assets/), "ThinkPad");

    expect(screen.getByText("Elena ThinkPad")).toBeInTheDocument();
    expect(screen.queryByText("Sarah MacBook")).not.toBeInTheDocument();
    expect(screen.queryByText("David Latitude")).not.toBeInTheDocument();
  });
});

describe("AssetTable row navigation", () => {
  // covers: AC-3 (clicking a row opens /assets/[id], where id is the tag)
  it("navigates to the asset detail page when a row is clicked", async () => {
    const user = userEvent.setup();
    const asset = makeAsset({ id: "OPUS-COMP-7499", name: "Elena ThinkPad" });
    renderTable([asset], { type: "Computer" });

    await user.click(screen.getByText("Elena ThinkPad"));

    expect(pushMock).toHaveBeenCalledWith("/assets/OPUS-COMP-7499");
  });
});

describe("AssetTable write gate (New asset)", () => {
  // covers: AC-6 (the New asset control is hidden without asset:write; the
  // default renderTable helper passes no canWrite, i.e. false)
  it("hides the New asset button by default (no asset:write)", () => {
    renderTable([makeAsset()], { type: "Computer" });
    expect(
      screen.queryByRole("button", { name: /New asset/i }),
    ).not.toBeInTheDocument();
  });

  // covers: AC-1, AC-6 (a writer sees New asset; it opens the create dialog with
  // the category's type pre-selected via presetType={config.type})
  it("shows New asset for a writer and opens the dialog with the category type pre-selected", async () => {
    const user = userEvent.setup();
    render(
      <AssetTable
        assets={[]}
        config={{ type: "Monitor", emptyMessage: "No monitors yet." }}
        canWrite
        people={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /New asset/i }));

    // The create dialog is open (its submit button is unique to it)...
    expect(
      await screen.findByRole("button", { name: /Create asset/i }),
    ).toBeInTheDocument();
    // ...and the Type trigger shows this category, pre-selected (AC-1).
    expect(screen.getByText("Monitor")).toBeInTheDocument();
  });

  // covers: AC-1 (the all-types dashboard view has no category, so the create
  // form opens with no type pre-selected and the user must choose one)
  it("opens the dialog with no type pre-selected on the all-types view", async () => {
    const user = userEvent.setup();
    render(
      <AssetTable
        assets={[]}
        config={{ showTypeFilter: true }}
        canWrite
        people={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /New asset/i }));

    expect(
      await screen.findByRole("button", { name: /Create asset/i }),
    ).toBeInTheDocument();
    // No preset: the Type trigger shows its placeholder, not a category.
    expect(screen.getByText("Choose a type")).toBeInTheDocument();
  });
});
