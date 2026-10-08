// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ComplianceFleet, type FleetRow } from "./compliance-fleet";
import type { CheckId, CheckStatus } from "@/lib/compliance-score";

const IDS: CheckId[] = [
  "bitlocker",
  "antivirus",
  "updates",
  "tpm",
  "secureBoot",
  "disk",
];

function checks(status: CheckStatus) {
  return IDS.map((id) => ({ id, label: id, status }));
}

const ROWS: FleetRow[] = [
  { tag: "A", name: "Perfect PC", score: 100, assessed: true, checks: checks("pass") },
  { tag: "B", name: "Bad PC", score: 30, assessed: true, checks: checks("fail") },
  { tag: "C", name: "Unknown PC", score: null, assessed: false, checks: checks("unknown") },
];

describe("ComplianceFleet", () => {
  it("renders every computer with a count", () => {
    render(<ComplianceFleet rows={ROWS} />);
    expect(screen.getByText("Perfect PC")).toBeTruthy();
    expect(screen.getByText("Bad PC")).toBeTruthy();
    expect(screen.getByText("Unknown PC")).toBeTruthy();
    expect(screen.getByText("3 of 3 computers")).toBeTruthy();
  });

  it("'Not assessed' shows for a computer with no score", () => {
    render(<ComplianceFleet rows={ROWS} />);
    expect(screen.getByText("Not assessed")).toBeTruthy();
  });

  it("the non-compliant filter hides a perfect (100) computer", async () => {
    const user = userEvent.setup();
    render(<ComplianceFleet rows={ROWS} />);
    await user.click(screen.getByRole("button", { name: /non-compliant/i }));
    expect(screen.queryByText("Perfect PC")).toBeNull();
    expect(screen.getByText("Bad PC")).toBeTruthy();
    expect(screen.getByText("Unknown PC")).toBeTruthy();
    expect(screen.getByText("2 of 3 computers")).toBeTruthy();
  });
});
