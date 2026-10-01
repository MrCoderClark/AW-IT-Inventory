// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PeopleDirectory } from "./people-directory";
import type { DirectoryPerson } from "@/lib/data";

/**
 * Component tests for the /people directory table (spec 16). The form dialog is
 * stubbed (it pulls in server actions + the DB). Traces:
 *   AC-1  write controls (New person, per-row edit) show only with asset:write
 *   AC-2  list renders each person with a device count; search filters; archived
 *         are hidden by default; the list paginates
 *   AC-10 a read-only viewer sees no add/edit controls
 */

vi.mock("./person-form-dialog", () => ({
  PersonFormDialog: () => null,
}));

function makePerson(overrides: Partial<DirectoryPerson> = {}): DirectoryPerson {
  return {
    id: "p1",
    name: "Ana López",
    initials: "AL",
    email: "ana@company.com",
    department: "Finance",
    jobTitle: "Analyst",
    phone: "",
    employeeId: "",
    officeLocation: "",
    officeLocationId: null,
    status: "active",
    deviceCount: 2,
    ...overrides,
  };
}

describe("PeopleDirectory — render (AC-2)", () => {
  it("lists each active person with their fields and device count", () => {
    render(
      <PeopleDirectory
        people={[
          makePerson(),
          makePerson({ id: "p2", name: "Bob Kent", initials: "BK", email: "bob@x.com", department: "IT", jobTitle: "Admin", deviceCount: 0 }),
        ]}
        canWrite
      />,
    );
    expect(screen.getByRole("link", { name: "Ana López" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bob Kent" })).toBeInTheDocument();
    expect(screen.getByText("Finance")).toBeInTheDocument();
    // Ana's device count is shown.
    expect(screen.getByText("2")).toBeInTheDocument();
    // Two people fit on one page.
    expect(screen.getByText("2 people · 1 of 1")).toBeInTheDocument();
  });

  it("shows the empty state when there are no people", () => {
    render(<PeopleDirectory people={[]} canWrite />);
    expect(screen.getByText(/No people yet/i)).toBeInTheDocument();
  });

  it("hides archived people by default (active filter)", () => {
    render(
      <PeopleDirectory
        people={[
          makePerson({ id: "a", name: "Active Amy", status: "active" }),
          makePerson({ id: "z", name: "Archived Zed", status: "archived" }),
        ]}
        canWrite
      />,
    );
    expect(screen.getByText("Active Amy")).toBeInTheDocument();
    expect(screen.queryByText("Archived Zed")).not.toBeInTheDocument();
  });
});

describe("PeopleDirectory — search (AC-2)", () => {
  it("filters the list by name as the user types", async () => {
    const user = userEvent.setup();
    render(
      <PeopleDirectory
        people={[
          makePerson({ id: "p1", name: "Ana López" }),
          makePerson({ id: "p2", name: "Bob Kent", email: "bob@x.com" }),
        ]}
        canWrite
      />,
    );
    await user.type(screen.getByPlaceholderText(/Search people/i), "bob");
    expect(screen.getByText("Bob Kent")).toBeInTheDocument();
    expect(screen.queryByText("Ana López")).not.toBeInTheDocument();
  });

  it("matches on department too", async () => {
    const user = userEvent.setup();
    render(
      <PeopleDirectory
        people={[
          makePerson({ id: "p1", name: "Ana López", department: "Finance" }),
          makePerson({ id: "p2", name: "Bob Kent", department: "Engineering" }),
        ]}
        canWrite
      />,
    );
    await user.type(screen.getByPlaceholderText(/Search people/i), "engineer");
    expect(screen.getByText("Bob Kent")).toBeInTheDocument();
    expect(screen.queryByText("Ana López")).not.toBeInTheDocument();
  });
});

describe("PeopleDirectory — pagination (AC-2)", () => {
  it("paginates at ten per page", () => {
    const people = Array.from({ length: 12 }, (_, i) =>
      makePerson({ id: `p${i}`, name: `Person ${String(i).padStart(2, "0")}`, initials: "PX" }),
    );
    render(<PeopleDirectory people={people} canWrite />);
    expect(screen.getByText("12 people · 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Previous/i })).toBeDisabled();
  });
});

describe("PeopleDirectory — write gate (AC-1, AC-10)", () => {
  it("shows the New person control and per-row edit for a writer", () => {
    render(<PeopleDirectory people={[makePerson()]} canWrite />);
    expect(screen.getByRole("button", { name: /New person/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit Ana López/i })).toBeInTheDocument();
  });

  it("hides every write control for a read-only viewer", () => {
    render(<PeopleDirectory people={[makePerson()]} canWrite={false} />);
    expect(screen.queryByRole("button", { name: /New person/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit Ana López/i })).toBeNull();
    // The name still links to the detail page (viewing stays open).
    expect(screen.getByRole("link", { name: "Ana López" })).toBeInTheDocument();
  });
});
