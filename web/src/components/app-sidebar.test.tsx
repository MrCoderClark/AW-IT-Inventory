// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AppSidebar } from "./app-sidebar";

/**
 * Component tests for the light sidebar (spec 17.01, AC-1.3) + the RBAC nav
 * visibility audit. Locks in that the nav links render, the current-path link is
 * marked active (aria-current), and that permission-gated Manage items (Admin,
 * Software Library, Scans, …) are hidden from users who lack the matching
 * permission — so a link is never shown for a page the user can't open.
 */

const { permsRef } = vi.hoisted(() => ({
  permsRef: { current: [] as string[] },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/printers",
}));
vi.mock("@/components/user-provider", () => ({
  useUser: () => ({ permissions: permsRef.current }),
}));

const ALL_PERMS = [
  "asset:read",
  "asset:write",
  "scan:read",
  "software:deploy",
  "user:admin",
];

beforeEach(() => {
  vi.clearAllMocks();
  permsRef.current = [...ALL_PERMS];
});

describe("AppSidebar — brand (AC-1.3)", () => {
  it("renders the public H2Tecs logo linking to the dashboard", () => {
    render(<AppSidebar />);
    const logo = screen.getByRole("img", { name: "H2Tecs IT Inventory" });
    expect(logo).toHaveAttribute("src", "/h2tecs-logo.svg");
    expect(logo.closest("a")).toHaveAttribute("href", "/dashboard");
  });
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

describe("AppSidebar — permission gating (RBAC audit)", () => {
  it("shows all gated Manage items to a fully-permissioned user", () => {
    render(<AppSidebar />);
    expect(screen.getByRole("link", { name: "Admin" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Software Library" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Scripts" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Scans" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alert rules" })).toHaveAttribute(
      "href",
      "/admin/alert-rules",
    );
  });

  it("hides user:admin items from a non-admin", () => {
    permsRef.current = ["asset:read", "asset:write", "scan:read", "software:deploy"];
    render(<AppSidebar />);
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Roles" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Alert rules" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Notifications" })).toBeNull();
    // Non-admin items the user still has stay visible.
    expect(
      screen.getByRole("link", { name: "Software Library" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Scripts" })).toBeInTheDocument();
  });

  it("hides elevated items from a read-only viewer (asset:read only)", () => {
    permsRef.current = ["asset:read", "report:read"];
    render(<AppSidebar />);
    // People & Media need asset:write; Software Library / Scripts software:deploy; Scans scan:read.
    expect(screen.queryByRole("link", { name: "People" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Media" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Software Library" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Scripts" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Scans" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Scan Jobs" })).toBeNull();
    // Baseline (asset:read) Manage items the viewer keeps.
    expect(screen.getByRole("link", { name: "Compliance" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Patches" })).toHaveAttribute(
      "href",
      "/patches",
    );
    expect(screen.getByRole("link", { name: "Reports" })).toBeInTheDocument();
  });

  it("shows People and Media to a user with asset:write", () => {
    permsRef.current = ["asset:read", "asset:write"];
    render(<AppSidebar />);
    expect(screen.getByRole("link", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Media" })).toBeInTheDocument();
  });
});
