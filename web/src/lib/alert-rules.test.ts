import { describe, it, expect } from "vitest";

import {
  applyMetricTick,
  episodeAction,
  formatCondition,
  gaugeOf,
  matchesThreshold,
  type MetricRule,
} from "./alert-rules";

/**
 * Pure evaluator for spec 30 metric threshold rules. Consecutive samples, not
 * wall-clock minutes; a null gauge skips the tick and leaves the streak alone.
 */

const disk90: MetricRule = {
  signal: "disk_pct",
  op: "gte",
  threshold: 90,
  consecutive: 1,
};

const cpu90x2: MetricRule = {
  signal: "cpu_pct",
  op: "gte",
  threshold: 90,
  consecutive: 2,
};

describe("matchesThreshold", () => {
  it("gte includes the threshold", () => {
    expect(matchesThreshold(90, "gte", 90)).toBe(true);
    expect(matchesThreshold(89.9, "gte", 90)).toBe(false);
  });

  it("gt is exclusive", () => {
    expect(matchesThreshold(90, "gt", 90)).toBe(false);
    expect(matchesThreshold(90.1, "gt", 90)).toBe(true);
  });

  it("lt / lte work for uptime-style rules", () => {
    expect(matchesThreshold(500, "lt", 600)).toBe(true);
    expect(matchesThreshold(600, "lte", 600)).toBe(true);
    expect(matchesThreshold(601, "lte", 600)).toBe(false);
  });
});

describe("applyMetricTick (AC-3, AC-4)", () => {
  it("skips a null gauge and leaves the streak unchanged", () => {
    expect(applyMetricTick(3, null, cpu90x2)).toEqual({
      consecutive: 3,
      verdict: "skip",
    });
  });

  it("fires on the first matching sample when consecutive is 1", () => {
    expect(applyMetricTick(0, 97, disk90)).toEqual({
      consecutive: 1,
      verdict: "firing",
    });
  });

  it("does not fire CPU ≥ 90 until the second consecutive sample", () => {
    const first = applyMetricTick(0, 94, cpu90x2);
    expect(first).toEqual({ consecutive: 1, verdict: "ok" });
    expect(applyMetricTick(first.consecutive, 91, cpu90x2)).toEqual({
      consecutive: 2,
      verdict: "firing",
    });
  });

  it("resets the streak when a readable sample is below the threshold", () => {
    expect(applyMetricTick(2, 40, cpu90x2)).toEqual({
      consecutive: 0,
      verdict: "ok",
    });
  });

  it("treats consecutive < 1 as 1", () => {
    const rule: MetricRule = { ...disk90, consecutive: 0 };
    expect(applyMetricTick(0, 95, rule).verdict).toBe("firing");
  });
});

describe("episodeAction", () => {
  it("fires when the streak newly crosses into firing", () => {
    expect(episodeAction("ok", "firing")).toBe("fire");
    expect(episodeAction(null, "firing")).toBe("fire");
  });

  it("recovers only from a notified firing episode", () => {
    expect(episodeAction("firing", "ok")).toBe("recover");
    expect(episodeAction("ok", "ok")).toBe("hold");
    expect(episodeAction(null, "ok")).toBe("hold");
  });

  it("holds while already firing, and on a skip", () => {
    expect(episodeAction("firing", "firing")).toBe("hold");
    expect(episodeAction("firing", "skip")).toBe("hold");
  });
});

describe("gaugeOf", () => {
  const sample = { cpuPct: 10, memPct: 20, diskPct: null, uptimeSec: 400 };

  it("maps each signal onto the sample field, preserving null gaps", () => {
    expect(gaugeOf(sample, "cpu_pct")).toBe(10);
    expect(gaugeOf(sample, "mem_pct")).toBe(20);
    expect(gaugeOf(sample, "disk_pct")).toBeNull();
    expect(gaugeOf(sample, "uptime_sec")).toBe(400);
  });
});

describe("formatCondition (AC-8)", () => {
  it("shows N samples and the ~duration at a 15-minute cadence", () => {
    expect(formatCondition(cpu90x2)).toBe(
      "CPU ≥ 90% for 2 samples (~30 min)",
    );
    expect(formatCondition(disk90)).toBe("Disk ≥ 90% for 1 sample (~15 min)");
  });
});
