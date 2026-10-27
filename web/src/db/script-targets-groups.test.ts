import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Device-group resolve path. DB + getDeviceGroup + getSubtreeIds mocked.
 */

const H = vi.hoisted(() => {
  const selectMock = vi.fn();
  const getGroupMock = vi.fn();
  const subtreeMock = vi.fn();
  return { selectMock, getGroupMock, subtreeMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: { select: H.selectMock },
}));
vi.mock("./device-groups", () => ({
  getDeviceGroup: (...args: unknown[]) => H.getGroupMock(...args),
}));
vi.mock("./queries", () => ({
  getSubtreeIds: (...args: unknown[]) => H.subtreeMock(...args),
}));

import {
  resolveDeviceGroup,
  resolveDeviceGroupAssetIds,
  resolveDeviceGroupRules,
  resolveScriptTargets,
} from "./script-targets";

function thenable(rows: unknown[]) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of [
    "from",
    "leftJoin",
    "innerJoin",
    "where",
    "limit",
    "orderBy",
  ]) {
    b[m] = self;
  }
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(res, rej);
  return b;
}

const ROW = {
  assetId: "a1",
  tag: "PC-1",
  ip: "192.168.72.10",
  bitlocker: "on",
  defenderRealtime: true,
  defenderSigAgeDays: 1,
  avProduct: "Defender",
  tpmReady: true,
  secureBoot: "on",
  updatesLastDays: 2,
  updatesPending: 0,
  systemDrivePctUsed: 40,
  hasCompliance: "a1",
};

beforeEach(() => {
  vi.clearAllMocks();
  H.selectMock.mockImplementation(() => thenable([ROW]));
  H.subtreeMock.mockResolvedValue(["loc-1"]);
  H.getGroupMock.mockResolvedValue({
    id: "g1",
    name: "Win11",
    rules: { osContains: "Windows 11", compliance: "any" },
  });
});

describe("resolveDeviceGroupRules", () => {
  it("returns IP matches and counts no-IP skips", async () => {
    H.selectMock.mockImplementation(() =>
      thenable([
        ROW,
        { ...ROW, assetId: "a2", tag: "PC-2", ip: null },
      ]),
    );
    const res = await resolveDeviceGroupRules({
      osContains: "Windows",
      compliance: "any",
    });
    expect(res.resolved).toEqual([
      { assetId: "a1", tag: "PC-1", ip: "192.168.72.10" },
    ]);
    expect(res.skippedNoIp).toBe(1);
  });

  it("returns empty when a location subtree is empty", async () => {
    H.subtreeMock.mockResolvedValue([]);
    const res = await resolveDeviceGroupRules({ locationId: "missing" });
    expect(res).toEqual({ resolved: [], skippedNoIp: 0 });
    expect(H.selectMock).not.toHaveBeenCalled();
  });
});

describe("resolveDeviceGroup / resolveScriptTargets group mode", () => {
  it("loads the group then resolves", async () => {
    const res = await resolveDeviceGroup("g1");
    expect(H.getGroupMock).toHaveBeenCalledWith("g1");
    expect(res.resolved[0]?.tag).toBe("PC-1");
  });

  it("returns empty when the group is missing", async () => {
    H.getGroupMock.mockResolvedValue(null);
    const res = await resolveDeviceGroup("missing");
    expect(res).toEqual({ resolved: [], skippedNoIp: 0 });
  });

  it("resolveScriptTargets delegates group mode", async () => {
    const res = await resolveScriptTargets({ mode: "group", groupId: "g1" });
    expect(res.resolved).toHaveLength(1);
  });
});

describe("resolveDeviceGroupAssetIds (alert scope, no IP gate)", () => {
  it("includes hosts without an IP", async () => {
    H.selectMock.mockImplementation(() =>
      thenable([
        ROW,
        { ...ROW, assetId: "a2", tag: "PC-2", ip: null },
      ]),
    );
    const ids = await resolveDeviceGroupAssetIds("g1");
    expect(ids).toEqual(new Set(["a1", "a2"]));
  });

  it("returns empty when the group is missing", async () => {
    H.getGroupMock.mockResolvedValue(null);
    const ids = await resolveDeviceGroupAssetIds("missing");
    expect(ids.size).toBe(0);
  });
});
