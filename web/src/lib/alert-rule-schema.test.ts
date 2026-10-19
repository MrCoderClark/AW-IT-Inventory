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
    });
    expect(parsed).toEqual({
      name: "CPU high",
      signal: "cpu_pct",
      op: "gte",
      threshold: 90,
      consecutive: 2,
      severity: "warning",
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
      }).success,
    ).toBe(false);
  });
});
