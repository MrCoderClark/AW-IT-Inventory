import { describe, it, expect } from "vitest";
import { nextRebootOccurrence } from "./reboot-occurrence";

describe("nextRebootOccurrence", () => {
  it("daily: later today", () => {
    const now = new Date("2026-10-23T14:00:00.000Z"); // 10:00 America/New_York (EDT)
    const next = nextRebootOccurrence({
      cadence: "daily",
      weekdays: null,
      localTime: "15:30",
      timezone: "America/New_York",
      now,
    });
    expect(next.toISOString()).toBe("2026-10-23T19:30:00.000Z");
  });

  it("daily: tomorrow when today's slot passed", () => {
    const now = new Date("2026-10-23T20:00:00.000Z"); // 16:00 EDT
    const next = nextRebootOccurrence({
      cadence: "daily",
      weekdays: null,
      localTime: "15:30",
      timezone: "America/New_York",
      now,
    });
    expect(next.toISOString()).toBe("2026-10-24T19:30:00.000Z");
  });

  it("weekly: next matching weekday", () => {
    // 2026-10-23 is Friday (5)
    const now = new Date("2026-10-23T12:00:00.000Z");
    const next = nextRebootOccurrence({
      cadence: "weekly",
      weekdays: [1], // Monday
      localTime: "02:00",
      timezone: "America/New_York",
      now,
    });
    expect(next.toISOString()).toBe("2026-10-26T06:00:00.000Z");
  });

  it("rejects empty weekdays for weekly", () => {
    expect(() =>
      nextRebootOccurrence({
        cadence: "weekly",
        weekdays: [],
        localTime: "02:00",
        timezone: "UTC",
        now: new Date("2026-10-23T00:00:00.000Z"),
      }),
    ).toThrow(/weekday/i);
  });
});
