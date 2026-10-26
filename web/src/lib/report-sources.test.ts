import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "./computer-audit-actions";
import {
  REPORT_SOURCES,
  reportSourceNeedsAuditRead,
  visibleReportSources,
} from "./report-sources";

const FIELD_IDS = [
  "occurredAt",
  "assetTag",
  "assetName",
  "serial",
  "action",
  "status",
  "operator",
  "source",
  "summary",
  "flagged",
  "location",
];

describe("computerAuditEvents catalog", () => {
  const source = REPORT_SOURCES.computerAuditEvents;

  it("registers the source with field ids that match the fetcher row keys", () => {
    expect(source.id).toBe("computerAuditEvents");
    expect(source.fields.map((f) => f.id)).toEqual(FIELD_IDS);
  });

  it("types action, status, source, and flagged for the builder", () => {
    const byId = Object.fromEntries(source.fields.map((f) => [f.id, f]));
    expect(byId.occurredAt.type).toBe("date");
    expect(byId.action.enumValues).toEqual([...AUDIT_ACTIONS]);
    expect(byId.status.enumValues).toEqual(["pending", "succeeded", "failed", "canceled"]);
    expect(byId.source.enumValues).toEqual(["admin_console", "scheduled", "collector"]);
    expect(byId.flagged.type).toBe("bool");
    expect(byId.location.type).toBe("text");
  });

  it("hides the source from viewers without audit:read", () => {
    expect(reportSourceNeedsAuditRead("computerAuditEvents")).toBe(true);
    expect(reportSourceNeedsAuditRead("assets")).toBe(false);
    const hidden = visibleReportSources(false).map((source) => source.id);
    const shown = visibleReportSources(true).map((source) => source.id);
    expect(hidden).not.toContain("computerAuditEvents");
    expect(shown).toContain("computerAuditEvents");
    expect(shown.filter((id) => id !== "computerAuditEvents")).toEqual(hidden);
  });
});
