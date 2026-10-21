import { describe, it, expect } from "vitest";

import { alertRuleInputSchema } from "./alert-rule-schema";

describe("alertRuleInputSchema (AC-1)", () => {
  it("coerces form strings and floors consecutive samples", () => {
    const parsed = alertRuleInputSchema.parse({
      name: "  CPU high  ",
      signal: "cpu_pct",
      op: "gte",
      threshold: "90",
      consecutive: "2.9",
      severity: "warning",
      ticketAutoCreate: "inherit",
    });
    expect(parsed).toEqual({
      name: "CPU high",
      signal: "cpu_pct",
      op: "gte",
      threshold: 90,
      consecutive: 2,
      severity: "warning",
      ticketAutoCreate: "inherit",
    });
  });

  it("rejects a blank name and a consecutive window under 1", () => {
    expect(alertRuleInputSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(
      alertRuleInputSchema.safeParse({
        name: "CPU",
        signal: "cpu_pct",
        op: "gte",
        threshold: 90,
        consecutive: 0,
        severity: "warning",
        ticketAutoCreate: "inherit",
      }).success,
    ).toBe(false);
  });

  it("accepts each ticketAutoCreate mode", () => {
    for (const ticketAutoCreate of ["inherit", "on", "off"] as const) {
      expect(
        alertRuleInputSchema.safeParse({
          name: "CPU",
          signal: "cpu_pct",
          op: "gte",
          threshold: 90,
          consecutive: 1,
          severity: "warning",
          ticketAutoCreate,
        }).success,
      ).toBe(true);
    }
  });
});
