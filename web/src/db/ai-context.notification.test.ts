import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const selects: unknown[][] = [];
  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where", "orderBy"]) {
      b[m] = () => b;
    }
    b.limit = () => b;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(selects.shift() ?? []).then(res, rej);
    return b;
  };
  return {
    selects,
    selectMock: vi.fn(() => makeSelect()),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: { select: H.selectMock },
}));

import { buildNotificationContextPack } from "./ai-context";

describe("buildNotificationContextPack", () => {
  beforeEach(() => {
    H.selects.length = 0;
    H.selectMock.mockClear();
  });

  it("returns null when the notification is missing", async () => {
    H.selects.push([]);
    await expect(buildNotificationContextPack("missing")).resolves.toBeNull();
  });

  it("returns a redacted pack without an asset", async () => {
    H.selects.push([
      {
        type: "metric-threshold",
        severity: "warning",
        title: "Disk",
        body: "password=hunter2 and more",
        tag: null,
        name: null,
        assetType: null,
        locationName: null,
      },
    ]);
    await expect(buildNotificationContextPack("n1")).resolves.toEqual({
      notification: {
        type: "metric-threshold",
        severity: "warning",
        title: "Disk",
        body: "[REDACTED] and more",
      },
      asset: null,
    });
  });

  it("joins the asset and uses the location name as locationPath", async () => {
    H.selects.push([
      {
        type: "printer-down",
        severity: "critical",
        title: "Printer down",
        body: "no snmp",
        tag: "PR-1",
        name: "Front desk",
        assetType: "Printer",
        locationName: "HQ",
      },
    ]);
    await expect(buildNotificationContextPack("n2")).resolves.toEqual({
      notification: {
        type: "printer-down",
        severity: "critical",
        title: "Printer down",
        body: "no snmp",
      },
      asset: {
        tag: "PR-1",
        name: "Front desk",
        type: "Printer",
        locationPath: "HQ",
      },
    });
  });

  it("leaves locationPath null when the asset has no location", async () => {
    H.selects.push([
      {
        type: "scan-failed",
        severity: "warning",
        title: "Scan",
        body: "timeout",
        tag: "PC-9",
        name: "Lab PC",
        assetType: "Computer",
        locationName: null,
      },
    ]);
    const pack = await buildNotificationContextPack("n4");
    expect(pack?.asset).toEqual({
      tag: "PC-9",
      name: "Lab PC",
      type: "Computer",
      locationPath: null,
    });
  });

  it("truncates long bodies to 2000 characters", async () => {
    H.selects.push([
      {
        type: "scan-failed",
        severity: "info",
        title: "Scan",
        body: "x".repeat(2500),
        tag: null,
        name: null,
        assetType: null,
        locationName: null,
      },
    ]);
    const pack = await buildNotificationContextPack("n3");
    expect(pack?.notification.body).toHaveLength(2000);
    expect(pack?.notification.body).toBe("x".repeat(2000));
  });
});
