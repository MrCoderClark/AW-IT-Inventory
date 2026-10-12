import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the Remote Actions Server Actions (spec 24). The db layer, the auth
 * session, and Next's cache are mocked; the `remote:shell` gate and the result
 * mapping run for real. Locks AC-8 (gate), AC-2/AC-9 (create reason mapping), and
 * AC-5/AC-6 (end ownership + outcomes).
 */
const {
  createMock,
  endMock,
  getCurrentUserMock,
  hasPermissionMock,
  revalidateMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  endMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("@/db/remote-sessions", () => ({
  createRemoteSession: createMock,
  requestEndSession: endMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
  hasPermission: hasPermissionMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { startRemoteSessionAction, endRemoteSessionAction } from "./remote-actions";

const admin = { email: "me@opus.local" };

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUserMock.mockResolvedValue(admin);
  hasPermissionMock.mockReturnValue(true);
});

describe("startRemoteSessionAction (AC-8, AC-2, AC-9)", () => {
  it("refuses a caller without remote:shell", async () => {
    hasPermissionMock.mockReturnValue(false);
    const res = await startRemoteSessionAction("PC-1");
    expect(res).toMatchObject({ ok: false });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a missing tag", async () => {
    expect(await startRemoteSessionAction("")).toMatchObject({ ok: false });
  });

  it("maps no-ip to a helpful error", async () => {
    createMock.mockResolvedValue({ ok: false, reason: "no-ip" });
    const res = await startRemoteSessionAction("PC-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no IP/i);
  });

  it("maps already-open", async () => {
    createMock.mockResolvedValue({ ok: false, reason: "already-open" });
    const res = await startRemoteSessionAction("PC-1");
    if (!res.ok) expect(res.error).toMatch(/already open/i);
  });

  it("returns the session id and revalidates on success", async () => {
    createMock.mockResolvedValue({ ok: true, sessionId: "s1" });
    const res = await startRemoteSessionAction("PC-1");
    expect(res).toEqual({ ok: true, sessionId: "s1" });
    expect(createMock).toHaveBeenCalledWith({
      assetTag: "PC-1",
      requestedBy: admin.email,
    });
    expect(revalidateMock).toHaveBeenCalledWith("/assets/PC-1");
  });
});

describe("endRemoteSessionAction (AC-5, AC-6)", () => {
  it("refuses without remote:shell", async () => {
    hasPermissionMock.mockReturnValue(false);
    expect(await endRemoteSessionAction("s1")).toMatchObject({ ok: false });
    expect(endMock).not.toHaveBeenCalled();
  });

  it("maps a non-owner outcome to forbidden", async () => {
    endMock.mockResolvedValue("forbidden");
    const res = await endRemoteSessionAction("s1");
    if (!res.ok) expect(res.error).toMatch(/another user/i);
  });

  it("maps notfound", async () => {
    endMock.mockResolvedValue("notfound");
    const res = await endRemoteSessionAction("s1");
    expect(res.ok).toBe(false);
  });

  it("succeeds when the db ends the session", async () => {
    endMock.mockResolvedValue("ok");
    const res = await endRemoteSessionAction("s1");
    expect(res).toMatchObject({ ok: true });
    expect(endMock).toHaveBeenCalledWith("s1", admin.email);
  });
});
