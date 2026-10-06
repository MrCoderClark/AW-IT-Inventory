import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the self-service account Server Actions. The aw-auth client, the
 * auth session, and the cookie store are mocked; validation runs for real.
 * Covers the logged-in gate, password-confirm validation, and that
 * "sign out everywhere else" forwards the current refresh token's `jti` so the
 * current browser stays signed in.
 */

const {
  changeMyPasswordMock,
  updateMyProfileMock,
  revokeSessionMock,
  revokeAllSessionsMock,
  getCurrentUserMock,
  readTokensMock,
} = vi.hoisted(() => ({
  changeMyPasswordMock: vi.fn(),
  updateMyProfileMock: vi.fn(),
  revokeSessionMock: vi.fn(),
  revokeAllSessionsMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  readTokensMock: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({
  changeMyPassword: changeMyPasswordMock,
  updateMyProfile: updateMyProfileMock,
  revokeSession: revokeSessionMock,
  revokeAllSessions: revokeAllSessionsMock,
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/auth/cookies", () => ({ readTokens: readTokensMock }));

import {
  changePasswordAction,
  revokeOtherSessionsAction,
  updateProfileAction,
} from "./account-actions";

/** A refresh JWT whose payload carries the given jti (header.payload.sig). */
function refreshWithJti(jti: string): string {
  const payload = Buffer.from(JSON.stringify({ jti })).toString("base64url");
  return `h.${payload}.s`;
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUserMock.mockResolvedValue({ id: "u1", email: "a@x.co" });
  readTokensMock.mockResolvedValue({
    access: "tok",
    refresh: refreshWithJti("CURRENT"),
  });
});

describe("changePasswordAction", () => {
  it("is blocked when not signed in", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await changePasswordAction({
      current_password: "old",
      new_password: "longenough1",
      confirm_password: "longenough1",
    });
    expect(res.ok).toBe(false);
    expect(changeMyPasswordMock).not.toHaveBeenCalled();
  });

  it("rejects a mismatched confirmation before calling aw-auth", async () => {
    const res = await changePasswordAction({
      current_password: "old",
      new_password: "longenough1",
      confirm_password: "different22",
    });
    expect(res.ok).toBe(false);
    expect(changeMyPasswordMock).not.toHaveBeenCalled();
  });

  it("forwards current + new password", async () => {
    changeMyPasswordMock.mockResolvedValue({ ok: true, data: undefined });
    const res = await changePasswordAction({
      current_password: "oldpass11",
      new_password: "longenough1",
      confirm_password: "longenough1",
    });
    expect(changeMyPasswordMock).toHaveBeenCalledWith("tok", "oldpass11", "longenough1");
    expect(res.ok).toBe(true);
  });
});

describe("updateProfileAction", () => {
  it("rejects an empty name", async () => {
    const res = await updateProfileAction({ full_name: "   " });
    expect(res.ok).toBe(false);
    expect(updateMyProfileMock).not.toHaveBeenCalled();
  });

  it("forwards the trimmed name", async () => {
    updateMyProfileMock.mockResolvedValue({ ok: true, data: {} });
    const res = await updateProfileAction({ full_name: "New Name" });
    expect(updateMyProfileMock).toHaveBeenCalledWith("tok", "New Name");
    expect(res.ok).toBe(true);
  });
});

describe("revokeOtherSessionsAction", () => {
  it("keeps the current session by forwarding its refresh jti", async () => {
    revokeAllSessionsMock.mockResolvedValue({ ok: true, data: { revoked: 2 } });
    const res = await revokeOtherSessionsAction();
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("tok", "CURRENT");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toMatch(/2 other/);
  });
});
