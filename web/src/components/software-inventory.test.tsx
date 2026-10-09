// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SoftwareInventory } from "./software-inventory";
import type { SoftwareInventoryRow } from "@/lib/data";

/**
 * Component tests for the /software dashboard table (spec 22). The server actions
 * and toast are stubbed. Traces:
 *   AC-4  lists each tracked title with its computer count and version
 *   spec22 search + publisher/version filters + pagination
 *   AC-7  the Add / Stop-tracking controls show only for a writer
 */

const addAction = vi.fn(async (..._args: unknown[]) => ({ ok: true, message: "ok" }) as const);
const removeAction = vi.fn(async (..._args: unknown[]) => ({ ok: true, message: "ok" }) as const);

vi.mock("@/app/(app)/software-actions", () => ({
  addTrackedSoftwareAction: (...args: unknown[]) => addAction(...args),
  removeTrackedSoftwareAction: (...args: unknown[]) => removeAction(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function makeRow(overrides: Partial<SoftwareInventoryRow> = {}): SoftwareInventoryRow {
  return {
    id: "t1",
    name: "Google Chrome",
    machineCount: 86,
    versions: ["138.0.7204.96"],
    publishers: ["Google LLC"],
    lastSeen: "2026-05-08T09:42:00Z",
    iconUrl: null,
    ...overrides,
  };
}

describe("SoftwareInventory — render (AC-4)", () => {
  it("lists each title with its publisher, version and computer count", () => {
    render(
      <SoftwareInventory
        rows={[
          makeRow(),
          makeRow({ id: "t2", name: "7-Zip", machineCount: 12, versions: ["24.09"], publishers: ["Igor Pavlov"] }),
        ]}
        canWrite
      />,
    );
    expect(screen.getByRole("link", { name: /Google Chrome/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /7-Zip/ })).toBeInTheDocument();
    expect(screen.getByText("Google LLC")).toBeInTheDocument();
    expect(screen.getByText("138.0.7204.96")).toBeInTheDocument();
    expect(screen.getByText("86")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1–2 of 2 software titles/)).toBeInTheDocument();
  });

  it("shows the empty state when nothing is tracked", () => {
    render(<SoftwareInventory rows={[]} canWrite />);
    expect(screen.getByText(/No software tracked yet/i)).toBeInTheDocument();
  });

  it("renders a resolved icon when present, generic glyph otherwise", () => {
    const { container } = render(
      <SoftwareInventory
        rows={[
          makeRow({ id: "av", name: "AV Defender", iconUrl: "/software-icons/av-defender.png" }),
          makeRow({ id: "cr", name: "Google Chrome", iconUrl: null }),
        ]}
        canWrite
      />,
    );
    // AV Defender has an icon; Chrome falls back to the glyph (one img total).
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe("/software-icons/av-defender.png");
  });

  it("collapses multiple versions to the latest plus a +N hint, and shows Multiple publishers", () => {
    render(
      <SoftwareInventory
        rows={[makeRow({ versions: ["1", "2", "3"], publishers: ["A Corp", "B Corp"] })]}
        canWrite
      />,
    );
    expect(screen.getByText("3")).toBeInTheDocument(); // latest version badge
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("Multiple")).toBeInTheDocument();
  });
});

describe("SoftwareInventory — search + filters", () => {
  it("filters by title as the user types", async () => {
    const user = userEvent.setup();
    render(
      <SoftwareInventory
        rows={[makeRow(), makeRow({ id: "t2", name: "7-Zip" })]}
        canWrite
      />,
    );
    await user.type(screen.getByPlaceholderText(/Search software title/i), "zip");
    expect(screen.getByRole("link", { name: /7-Zip/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Google Chrome/ })).not.toBeInTheDocument();
  });
});

describe("SoftwareInventory — pagination", () => {
  it("paginates at ten per page", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      makeRow({ id: `t${i}`, name: `Title ${String(i).padStart(2, "0")}` }),
    );
    render(<SoftwareInventory rows={rows} canWrite />);
    expect(screen.getByText(/Showing 1–10 of 12 software titles/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Previous/i })).toBeDisabled();
  });
});

describe("SoftwareInventory — write gate (AC-7)", () => {
  it("shows Add software for a writer", () => {
    render(<SoftwareInventory rows={[makeRow()]} canWrite />);
    expect(screen.getByRole("button", { name: /Add software/i })).toBeInTheDocument();
  });

  it("hides Add software for a read-only viewer", () => {
    render(<SoftwareInventory rows={[makeRow()]} canWrite={false} />);
    expect(screen.queryByRole("button", { name: /Add software/i })).toBeNull();
    // Viewing stays open: the title still links to the drill-down.
    expect(screen.getByRole("link", { name: /Google Chrome/ })).toBeInTheDocument();
  });
});
