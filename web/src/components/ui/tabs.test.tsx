// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Tabs, TabsList, TabsTab, TabsPanel } from "./tabs";

/**
 * Component tests for the detail-page Tabs strip (spec 17.01, AC-1.5). Locks in
 * that the strip has the right roles, shows the selected tab's panel, swaps
 * panels on click without navigating, and is keyboard operable with the arrow
 * keys. The blue active underline is a visual detail (verified live by
 * /check verify), not asserted here.
 */

function Harness() {
  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTab value="overview">Overview</TabsTab>
        <TabsTab value="network">Network</TabsTab>
        <TabsTab value="activity">Activity</TabsTab>
      </TabsList>
      <TabsPanel value="overview">Overview content</TabsPanel>
      <TabsPanel value="network">Network content</TabsPanel>
      <TabsPanel value="activity">Activity content</TabsPanel>
    </Tabs>
  );
}

describe("Tabs — roles and default selection (AC-1.5)", () => {
  it("renders a tablist with one tab per value and selects the default tab", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(
      screen.getByRole("tab", { name: "Overview", selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Overview content");
  });
});

describe("Tabs — panel swap on click (AC-1.5)", () => {
  it("selects the clicked tab and shows its panel, without navigating away", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("tab", { name: "Network" }));

    expect(
      screen.getByRole("tab", { name: "Network", selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Network content");
    // The previously selected tab is no longer selected (swap, not add).
    expect(
      screen.queryByRole("tab", { name: "Overview", selected: true }),
    ).toBeNull();
  });
});

describe("Tabs — keyboard operability (AC-1.5)", () => {
  it("moves focus to the next tab with the right arrow key", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Network" })).toHaveFocus();
  });
});
