// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { HeroHeader } from "./hero-header";

/**
 * Component tests for the reusable page HeroHeader (spec 17.01, AC-1.4). Locks
 * in the title/subtitle/actions/icon rendering, the optional decorative
 * background image (present when given, hidden from assistive tech, absent
 * otherwise). Text contrast over the scrim is visual and is verified live by
 * /check verify, not here.
 */

describe("HeroHeader — content (AC-1.4)", () => {
  it("renders the title as a level-1 heading, plus subtitle and actions", () => {
    render(
      <HeroHeader
        title="Printers"
        subtitle="Manage and view all printer assets."
        actions={<button>New Printer</button>}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Printers" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Manage and view all printer assets."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New Printer" }),
    ).toBeInTheDocument();
  });

  it("renders the icon passed into the tile", () => {
    render(<HeroHeader title="Printers" icon={<svg data-testid="hero-icon" />} />);
    expect(screen.getByTestId("hero-icon")).toBeInTheDocument();
  });

  it("omits subtitle and actions when they are not given", () => {
    render(<HeroHeader title="Printers" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Printers" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("HeroHeader — background image (AC-1.4)", () => {
  it("renders a decorative background image hidden from assistive tech when given", () => {
    const { container } = render(
      <HeroHeader title="Printers" backgroundImage="/heroes/printers.png" />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/heroes/printers.png");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
  });

  it("renders no image when no backgroundImage is given", () => {
    const { container } = render(<HeroHeader title="Printers" />);
    expect(container.querySelector("img")).toBeNull();
  });
});
