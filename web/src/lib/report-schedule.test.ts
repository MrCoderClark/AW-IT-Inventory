import { describe, it, expect } from "vitest";

import {
  computeNextRun,
  describeSchedule,
  validateScheduleInput,
} from "./report-schedule";

/**
 * Unit tests for the pure schedule core (spec 26 phase 2, slice 2a): the cadence
 * math (`computeNextRun`), the human summary, and input validation. All work in
 * local wall-clock time, so the tests build `from`/expected with the local Date
 * constructor and assert in local terms.
 */

describe("computeNextRun — daily", () => {
  it("fires later today when the time is still ahead", () => {
    const from = new Date(2026, 5, 15, 8, 0, 0); // Jun 15, 08:00
    const next = computeNextRun({ cadence: "daily", hour: 9, minute: 30 }, from);
    expect(next).toEqual(new Date(2026, 5, 15, 9, 30, 0, 0));
  });

  it("rolls to tomorrow when today's time has passed", () => {
    const from = new Date(2026, 5, 15, 10, 0, 0);
    const next = computeNextRun({ cadence: "daily", hour: 9, minute: 0 }, from);
    expect(next).toEqual(new Date(2026, 5, 16, 9, 0, 0, 0));
  });
});

describe("computeNextRun — weekly", () => {
  it("lands on the next occurrence of the weekday, in the future", () => {
    const from = new Date(2026, 5, 15, 12, 0, 0);
    const target = 3; // Wednesday
    const next = computeNextRun(
      { cadence: "weekly", hour: 9, minute: 0, weekday: target },
      from,
    );
    expect(next.getDay()).toBe(target);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    const days = (next.getTime() - from.getTime()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(7);
  });

  it("skips a week when it's the target day but the time has passed", () => {
    const from = new Date(2026, 5, 15, 12, 0, 0); // 09:00 already passed
    const today = from.getDay();
    const next = computeNextRun(
      { cadence: "weekly", hour: 9, minute: 0, weekday: today },
      from,
    );
    // Same weekday, exactly seven calendar days later at 09:00.
    expect(next).toEqual(new Date(2026, 5, 22, 9, 0, 0, 0));
    expect(next.getDay()).toBe(today);
  });
});

describe("computeNextRun — monthly", () => {
  it("clamps the day of month to a short month", () => {
    const from = new Date(2026, 1, 1, 10, 0, 0); // Feb 1
    const next = computeNextRun(
      { cadence: "monthly", hour: 9, minute: 0, dayOfMonth: 31 },
      from,
    );
    expect(next).toEqual(new Date(2026, 1, 28, 9, 0, 0, 0)); // Feb 28 2026
  });

  it("advances to next month when this month's day has passed", () => {
    const from = new Date(2026, 5, 20, 10, 0, 0); // Jun 20
    const next = computeNextRun(
      { cadence: "monthly", hour: 9, minute: 0, dayOfMonth: 5 },
      from,
    );
    expect(next).toEqual(new Date(2026, 6, 5, 9, 0, 0, 0)); // Jul 5
  });
});

describe("describeSchedule", () => {
  it("summarizes each cadence", () => {
    expect(describeSchedule({ cadence: "daily", hour: 9, minute: 0 })).toBe(
      "Daily at 09:00",
    );
    expect(
      describeSchedule({ cadence: "weekly", hour: 17, minute: 5, weekday: 1 }),
    ).toBe("Weekly on Mondays at 17:05");
    expect(
      describeSchedule({ cadence: "monthly", hour: 8, minute: 0, dayOfMonth: 1 }),
    ).toBe("Monthly on the 1st at 08:00");
  });
});

describe("validateScheduleInput", () => {
  const base = {
    cadence: "daily",
    hour: 9,
    minute: 0,
    recipients: ["a@b.com"],
    format: "csv",
  };

  it("accepts a valid daily schedule and normalizes recipients", () => {
    const res = validateScheduleInput({
      ...base,
      recipients: [" A@B.com ", "a@b.com", "c@d.com"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.recipients).toEqual(["a@b.com", "c@d.com"]); // trimmed, lowered, deduped
      expect(res.input.weekday).toBeNull();
    }
  });

  it("requires at least one recipient", () => {
    const res = validateScheduleInput({ ...base, recipients: [] });
    expect(res.ok).toBe(false);
  });

  it("rejects a malformed email", () => {
    const res = validateScheduleInput({ ...base, recipients: ["not-an-email"] });
    expect(res.ok).toBe(false);
  });

  it("requires a weekday for weekly and a day-of-month for monthly", () => {
    expect(validateScheduleInput({ ...base, cadence: "weekly" }).ok).toBe(false);
    expect(validateScheduleInput({ ...base, cadence: "monthly" }).ok).toBe(false);
    expect(
      validateScheduleInput({ ...base, cadence: "weekly", weekday: 2 }).ok,
    ).toBe(true);
  });

  it("rejects an out-of-range hour", () => {
    expect(validateScheduleInput({ ...base, hour: 24 }).ok).toBe(false);
  });
});
