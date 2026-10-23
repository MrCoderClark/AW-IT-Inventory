// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AuditLogView, type AuditLogFilters } from "./audit-log-view";
import type { AuditKpis, AuditListItem } from "@/db/computer-audit";

/**
 * Audit log view: KPI strip, one sample row, client filters, and CSV export
 * of the rows those filters leave visible.
 */

const filters: AuditLogFilters = {
  asset: "",
  action: "",
  operator: "",
  range: "30",
  locationId: "",
};

const kpis: AuditKpis = {
  total: 14203,
  today: 386,
  uniqueOperators: 47,
  flagged: 3,
};

const assigned: AuditListItem = {
  id: "evt-assign",
  occurredAtIso: "2026-10-23T16:36:00.000Z",
  assetTag: "H2TECS-COMP-CK1GV",
  assetName: "Front desk",
  serial: "71F4GK2",
  action: "assignment_change",
  status: "succeeded",
  operator: "joe@example.com",
  source: "admin_console",
  summary: "Assigned to Ada Lovelace",
  flagged: false,
  details: { holder: "Ada Lovelace", ticket: "T-14" },
};

const reboot: AuditListItem = {
  id: "evt-reboot",
  occurredAtIso: "2026-10-22T12:00:00.000Z",
  assetTag: "H2TECS-COMP-OTHER",
  assetName: "Lab PC",
  serial: "ABC123",
  action: "reboot",
  status: "failed",
  operator: "system",
  source: "scheduled",
  summary: "Scheduled reboot",
  flagged: true,
  details: {},
};

beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: () => "blob:unused",
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderLog(events: AuditListItem[] = [assigned, reboot]) {
  return render(
    <AuditLogView
      events={events}
      kpis={kpis}
      locations={[
        {
          id: "11111111-1111-4111-8111-111111111111",
          path: "New York",
        },
      ]}
      filters={filters}
    />,
  );
}

describe("AuditLogView", () => {
  it("renders the activity header, KPIs, and a sample row", () => {
    renderLog();

    expect(
      screen.getByRole("heading", { level: 1, name: /Audit log/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText(kpis.total.toLocaleString())).toBeInTheDocument();
    expect(screen.getByText(kpis.today.toLocaleString())).toBeInTheDocument();
    expect(
      screen.getByText(kpis.uniqueOperators.toLocaleString()),
    ).toBeInTheDocument();
    expect(screen.getByText(kpis.flagged.toLocaleString())).toBeInTheDocument();
    expect(screen.getByText("Total events")).toBeInTheDocument();
    expect(screen.getByText("Actions today")).toBeInTheDocument();
    expect(screen.getByText("Unique operators")).toBeInTheDocument();
    expect(screen.getByText("Flagged")).toBeInTheDocument();

    for (const header of [
      "Time",
      "Asset",
      "Serial",
      "Action",
      "Operator",
      "Source",
      "Status",
      "Details",
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }

    const table = within(screen.getByRole("table"));
    expect(
      table.getByRole("link", { name: "H2TECS-COMP-CK1GV" }),
    ).toHaveAttribute("href", "/assets/H2TECS-COMP-CK1GV");
    expect(table.getByText("71F4GK2")).toBeInTheDocument();
    expect(table.getByText("Assignment change")).toBeInTheDocument();
    expect(table.getByText("joe@example.com")).toBeInTheDocument();
    expect(table.getByText("Admin Console")).toBeInTheDocument();
    expect(table.getByText("Success")).toBeInTheDocument();
    expect(table.getByText("Assigned to Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveTextContent(
      "New York",
    );
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveValue("30");
  });

  it("expands a row to show detail fields", async () => {
    const user = userEvent.setup();
    renderLog();

    expect(screen.queryByText("T-14")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Assigned to Ada Lovelace/ }),
    );
    expect(screen.getByText("T-14")).toBeInTheDocument();
    expect(screen.getByText("Holder")).toBeInTheDocument();
  });

  it("exports only the rows left by the current filters", async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    const downloads: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:audit";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });

    renderLog();
    await user.selectOptions(screen.getByRole("combobox", { name: "Action" }), "reboot");

    expect(screen.queryByText("Assigned to Ada Lovelace")).not.toBeInTheDocument();
    expect(screen.getByText("Scheduled reboot")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "H2TECS-COMP-CK1GV" })).toBeNull();
    expect(window.location.search).toContain("action=reboot");

    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(downloads[0]).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = (await blobs[0].text()).replace(/^\uFEFF/, "");
    expect(text).toBe(
      [
        "Time,Asset,Serial,Action,Operator,Source,Status,Details",
        "2026-10-22T12:00:00.000Z,H2TECS-COMP-OTHER,ABC123,Reboot,system,Scheduled,Failed,Scheduled reboot",
      ].join("\r\n"),
    );
    expect(text).not.toContain("Assigned to Ada Lovelace");
  });

  it("disables export when the window is empty", () => {
    renderLog([]);
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    expect(screen.getByText("No audit events in this window.")).toBeInTheDocument();
  });
});
