import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the tracked-software Server Actions (spec 15). The DB helpers, the
 * auth session, and Next's cache are mocked; the permission gate and the input
 * validation run for real. Locks in AC-7 (server-side scan:write gate on both
 * actions) and AC-1 (add/remove write paths + the duplicate/empty error mapping),
 * the criteria `/check verify` could not exercise as a viewer.
 */

const { addMock, removeMock, getCurrentUserMock, hasPermissionMock, revalidateMock } =
  vi.hoisted(() => ({
    addMock: vi.fn(),
    removeMock: vi.fn(),
    getCurrentUserMock: vi.fn(),
    hasPermissionMock: vi.fn(),
    revalidateMock: vi.fn(),
  }));

vi.mock("@/db/software", () => ({
  addTrackedSoftware: addMock,
  removeTrackedSoftware: removeMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
  hasPermission: hasPermissionMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import {
  addTrackedSoftwareAction,
  removeTrackedSoftwareAction,
} from "./software-actions";

/** Grant or deny scan:write. hasPermission is what actually decides. */
function grant(allowed: boolean) {
  getCurrentUserMock.mockResolvedValue(allowed ? { email: "a@x.co" } : null);
  hasPermissionMock.mockReturnValue(allowed);
}

beforeEach(() => vi.clearAllMocks());

describe("addTrackedSoftwareAction — permission gate (AC-7)", () => {
  it("refuses a caller without scan:write and writes nothing", async () => {
    grant(false);
    const res = await addTrackedSoftwareAction("Chrome");
    expect(res.ok).toBe(false);
    expect(addMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe("addTrackedSoftwareAction — validation + errors (AC-1)", () => {
  beforeEach(() => grant(true));

  it("rejects a non-string name", async () => {
    const res = await addTrackedSoftwareAction(42);
    expect(res.ok).toBe(false);
    expect(addMock).not.toHaveBeenCalled();
  });

  it("surfaces an empty-name rejection from the helper", async () => {
    addMock.mockResolvedValue("empty");
    const res = await addTrackedSoftwareAction("   ");
    expect(res.ok).toBe(false);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate rejection with the offending title", async () => {
    addMock.mockResolvedValue("duplicate");
    const res = await addTrackedSoftwareAction("chrome");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already tracked/i);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("adds the title, revalidates both pages, and returns ok", async () => {
    addMock.mockResolvedValue("ok");
    const res = await addTrackedSoftwareAction("  Chrome  ");
    expect(addMock).toHaveBeenCalledWith("  Chrome  ");
    expect(revalidateMock).toHaveBeenCalledWith("/admin");
    expect(revalidateMock).toHaveBeenCalledWith("/software");
    expect(res.ok).toBe(true);
  });
});

describe("removeTrackedSoftwareAction — gate + write (AC-7, AC-1)", () => {
  it("refuses a caller without scan:write and deletes nothing", async () => {
    grant(false);
    const res = await removeTrackedSoftwareAction("some-id");
    expect(res.ok).toBe(false);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("rejects a missing/non-string id", async () => {
    grant(true);
    const res = await removeTrackedSoftwareAction(undefined);
    expect(res.ok).toBe(false);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("reports when the id was already gone", async () => {
    grant(true);
    removeMock.mockResolvedValue(false);
    const res = await removeTrackedSoftwareAction("11111111-1111-1111-1111-111111111111");
    expect(res.ok).toBe(false);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("removes the title, revalidates, and returns ok", async () => {
    grant(true);
    removeMock.mockResolvedValue(true);
    const res = await removeTrackedSoftwareAction("11111111-1111-1111-1111-111111111111");
    expect(removeMock).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(revalidateMock).toHaveBeenCalledWith("/software");
    expect(res.ok).toBe(true);
  });
});
