// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AppSidebar } from "./app-sidebar";

/**
 * Component tests for the light sidebar (spec 17.01, AC-1.3). Locks in that the
 * nav links render, the link matching the current path is marked the active
 * page (aria-current), and the Admin link is gated on the admin permission. The
 * blue active treatment and left indicator bar are visual (verified live by
 * /check verify); here we assert the accessible active state, not colors.
 */

const { hasPermMock } = vi.hoisted(() => ({ hasPermMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/printers",
}));
vi.mock("@/components/user-provider", () => ({
  useHasPermission: (perm: string) => hasPermMock(perm),
}));

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
});

describe("AppSidebar — nav links (AC-1.3)", () => {
  it("renders the primary and asset nav links with their hrefs", () => {
    render(<AppSidebar />);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.getByRole("link", { name: "Printers" })).toHaveAttribute(
      "href",
      "/printers",
    );
    expect(screen.getByRole("link", { name: "Computers" })).toHaveAttribute(
      "href",
      "/computers",
    );
  });
});

describe("AppSidebar — active item (AC-1.3)", () => {
  it("marks the link matching the current path as the active page", () => {
    render(<AppSidebar />);
    expect(screen.getByRole("link", { name: "Printers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("link", { name: "Computers" }),
    ).not.toHaveAttribute("aria-current");
  });
});

describe("AppSidebar — admin gating (AC-1.3)", () => {
  it("shows the Admin link to a user with the admin permission", () => {
    hasPermMock.mockReturnValue(true);
    render(<AppSidebar />);
    expect(screen.getByRole("link", { name: "Admin" })).toBeInTheDocument();
  });

  it("hides the Admin link from a user without the admin permission", () => {
    hasPermMock.mockReturnValue(false);
    render(<AppSidebar />);
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });
});
