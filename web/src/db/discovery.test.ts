import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the discovery-settings data helpers (spec 13). The DB client is
 * the boundary, so it is mocked; the coalescing rule (absent row = on) runs for
 * real. Locks in AC-2 (default on) and the AC-1 upsert write path.
 */

const { selectMock, fromMock, insertMock, valuesMock, onConflictMock } =
  vi.hoisted(() => {
    const fromMock = vi.fn();
    const selectMock = vi.fn(() => ({ from: fromMock }));
    const onConflictMock = vi.fn(() => Promise.resolve());
    const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictMock }));
    const insertMock = vi.fn(() => ({ values: valuesMock }));
    return { selectMock, fromMock, insertMock, valuesMock, onConflictMock };
  });

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: { select: selectMock, insert: insertMock },
}));

import {
  getDiscoverySettings,
  setDiscoveryToggle,
  isDiscoveryType,
  DISCOVERY_TYPES,
} from "./discovery";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDiscoverySettings — absent row = on (AC-2)", () => {
  it("defaults every type to on when the table is empty", async () => {
    fromMock.mockResolvedValue([]);
    expect(await getDiscoverySettings()).toEqual({
      computer: true,
      printer: true,
    });
  });

  it("returns a saved false and coalesces the missing type to on", async () => {
    // covers: AC-2 — only `printer` has a row; `computer` coalesces to true.
    fromMock.mockResolvedValue([{ deviceType: "printer", enabled: false }]);
    expect(await getDiscoverySettings()).toEqual({
      computer: true,
      printer: false,
    });
  });

  it("reflects both saved rows", async () => {
    fromMock.mockResolvedValue([
      { deviceType: "computer", enabled: false },
      { deviceType: "printer", enabled: false },
    ]);
    expect(await getDiscoverySettings()).toEqual({
      computer: false,
      printer: false,
    });
  });
});

describe("setDiscoveryToggle — upsert (AC-1)", () => {
  it("upserts the row with the new enabled value", async () => {
    await setDiscoveryToggle("computer", false);
    expect(insertMock).toHaveBeenCalledOnce();
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ deviceType: "computer", enabled: false }),
    );
    expect(onConflictMock).toHaveBeenCalledOnce();
    // The upsert sets the enabled flag (and updatedAt) on conflict.
    const arg = onConflictMock.mock.calls[0][0] as { set: { enabled: boolean } };
    expect(arg.set).toEqual(expect.objectContaining({ enabled: false }));
  });
});

describe("isDiscoveryType", () => {
  it("accepts the known types and rejects anything else", () => {
    for (const t of DISCOVERY_TYPES) expect(isDiscoveryType(t)).toBe(true);
    expect(isDiscoveryType("phone")).toBe(false);
    expect(isDiscoveryType(null)).toBe(false);
    expect(isDiscoveryType(3)).toBe(false);
  });
});
