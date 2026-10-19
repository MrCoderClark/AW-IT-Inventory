import { describe, expect, it } from "vitest";

import {
  validateScriptScheduleInput,
  validateTargetSpec,
} from "./script-schedule";

describe("validateTargetSpec", () => {
  it("accepts tags", () => {
    expect(
      validateTargetSpec({ mode: "tags", tags: ["A", "B", "A", ""] }),
    ).toEqual({
      ok: true,
      spec: { mode: "tags", tags: ["A", "B"] },
    });
  });

  it("rejects empty tags", () => {
    expect(validateTargetSpec({ mode: "tags", tags: [] })).toEqual({
      ok: false,
      error: "Select at least one computer.",
    });
  });

  it("accepts location", () => {
    expect(
      validateTargetSpec({ mode: "location", locationId: "loc-1" }),
    ).toEqual({
      ok: true,
      spec: { mode: "location", locationId: "loc-1" },
    });
  });
});

describe("validateScriptScheduleInput", () => {
  it("accepts daily", () => {
    expect(
      validateScriptScheduleInput({ cadence: "daily", hour: 9, minute: 30 }),
    ).toEqual({
      ok: true,
      input: { cadence: "daily", hour: 9, minute: 30, weekday: null },
    });
  });

  it("requires weekday for weekly", () => {
    expect(
      validateScriptScheduleInput({ cadence: "weekly", hour: 9, minute: 0 }),
    ).toEqual({ ok: false, error: "Pick a day of the week." });
  });

  it("rejects monthly", () => {
    expect(
      validateScriptScheduleInput({
        cadence: "monthly",
        hour: 9,
        minute: 0,
        dayOfMonth: 1,
      }),
    ).toEqual({ ok: false, error: "Choose daily or weekly." });
  });
});
