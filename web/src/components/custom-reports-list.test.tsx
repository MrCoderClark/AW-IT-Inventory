// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { CustomReportsList, type CustomReportCard } from "./custom-reports-list";

/**
 * Component tests for the saved-reports grid (spec 26, slice 1d). The delete
 * action + router are the boundary and are mocked. The point being locked is the
 * RBAC gate: a read-only (report:read) viewer can open saved reports but sees no
 * edit/delete controls, while a report:write viewer does.
 */

vi.mock("@/app/(app)/reports/report-actions", () => ({
  deleteReportAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const reports: CustomReportCard[] = [
  {
    id: "r1",
    name: "Dell laptops out of warranty",
    description: "Finance, Bronx",
    source: "computers",
    updatedAt: "2026-10-14T12:00:00Z",
  },
];

describe("CustomReportsList", () => {
  it("links each report to its run page and shows the source label", () => {
    render(<CustomReportsList reports={reports} canWrite={false} />);
    const link = screen.getByRole("link", {
      name: /Dell laptops out of warranty/i,
    });
    expect(link).toHaveAttribute("href", "/reports/custom/r1");
    expect(screen.getByText("Computers + compliance")).toBeInTheDocument();
  });

  it("hides the edit/delete menu from a read-only viewer", () => {
    render(<CustomReportsList reports={reports} canWrite={false} />);
    expect(
      screen.queryByRole("button", { name: /Actions for/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the actions menu to a report:write viewer", () => {
    render(<CustomReportsList reports={reports} canWrite />);
    expect(
      screen.getByRole("button", { name: /Actions for Dell laptops/i }),
    ).toBeInTheDocument();
  });

  it("groups reports by folder, with uncategorized last", () => {
    render(
      <CustomReportsList
        reports={[
          { ...reports[0], id: "a", name: "Alpha", category: "Hardware" },
          { ...reports[0], id: "b", name: "Beta", category: null },
          { ...reports[0], id: "c", name: "Gamma", category: "Compliance" },
        ]}
        canWrite={false}
      />,
    );
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    // Real folders alphabetical, Uncategorized last.
    expect(headings[0]).toContain("Compliance");
    expect(headings[1]).toContain("Hardware");
    expect(headings[2]).toContain("Uncategorized");
  });

  it("renders an empty state with a New report CTA when there are none", () => {
    render(<CustomReportsList reports={[]} canWrite />);
    expect(screen.getByText(/No saved reports yet/i)).toBeInTheDocument();
    expect(screen.getByText(/New custom report/i).closest("a")).toHaveAttribute(
      "href",
      "/reports/builder",
    );
  });
});
