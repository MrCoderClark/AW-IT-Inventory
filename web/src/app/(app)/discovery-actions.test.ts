import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the discovery-toggle Server Action (spec 13). The DB helper, the
 * auth session, and Next's cache are mocked; the permission gate and the input
 * validation run for real. Locks in AC-7 (server-side scan:write gate) and AC-1
 * (the write path), the criteria `/check verify` could not exercise as a viewer.
 */

const { setToggleMock, getCurrentUserMock, hasPermissionMock, revalidateMock } =
  vi.hoisted(() => ({
    setToggleMock: vi.fn(() => Promise.resolve()),
    getCurrentUserMock: vi.fn(),
    hasPermissionMock: vi.fn(),
    revalidateMock: vi.fn(),
  }));

vi.mock("@/db/discovery", () => ({
  DISCOVERY_TYPES: ["computer", "printer"],
  isDiscoveryType: (v: unknown) => v === "computer" || v === "printer",
  setDiscoveryToggle: setToggleMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
  hasPermission: hasPermissionMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { setDiscoveryToggleAction } from "./discovery-actions";

/** Grant or deny scan:write for a test. hasPermission is what actually decides. */
function grant(allowed: boolean) {
  getCurrentUserMock.mockResolvedValue(allowed ? { email: "a@x.co" } : null);
  hasPermissionMock.mockReturnValue(allowed);
}

beforeEach(() => vi.clearAllMocks());

describe("setDiscoveryToggleAction — permission gate (AC-7)", () => {
  it("refuses a caller without scan:write and writes nothing", async () => {
    grant(false);
    const res = await setDiscoveryToggleAction("computer", false);
    expect(res.ok).toBe(false);
    expect(setToggleMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe("setDiscoveryToggleAction — validation", () => {
  beforeEach(() => grant(true));

  it("rejects an unknown device type", async () => {
    const res = await setDiscoveryToggleAction("phone", false);
    expect(res).toEqual({ ok: false, error: "Unknown device type." });
    expect(setToggleMock).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean enabled value", async () => {
    const res = await setDiscoveryToggleAction("computer", "yes");
    expect(res.ok).toBe(false);
    expect(setToggleMock).not.toHaveBeenCalled();
  });
});

describe("setDiscoveryToggleAction — write path (AC-1)", () => {
  beforeEach(() => grant(true));

  it("upserts the toggle, revalidates /admin, and returns ok", async () => {
    const res = await setDiscoveryToggleAction("printer", false);
    expect(setToggleMock).toHaveBeenCalledWith("printer", false);
    expect(revalidateMock).toHaveBeenCalledWith("/admin");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toMatch(/Printers/i);
  });
});
