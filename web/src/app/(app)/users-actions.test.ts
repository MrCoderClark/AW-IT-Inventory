import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the user-management Server Actions. The aw-auth admin client, the
 * auth session, the cookie store, and Next's cache are mocked; the `user:admin`
 * permission gate and the input validation run for real. Locks in the
 * server-side gate (a non-admin writes nothing) and the token-forwarding path.
 */

const {
  createUserMock,
  updateUserMock,
  setUserPasswordMock,
  deleteUserMock,
  getCurrentUserMock,
  hasPermissionMock,
  readTokensMock,
  revalidateMock,
} = vi.hoisted(() => ({
  createUserMock: vi.fn(),
  updateUserMock: vi.fn(),
  setUserPasswordMock: vi.fn(),
  deleteUserMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  readTokensMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({
  createUser: createUserMock,
  updateUser: updateUserMock,
  setUserPassword: setUserPasswordMock,
  deleteUser: deleteUserMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
  hasPermission: hasPermissionMock,
}));
vi.mock("@/lib/auth/cookies", () => ({ readTokens: readTokensMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import {
  createUserAction,
  deleteUserAction,
  setUserPasswordAction,
  updateUserAction,
} from "./users-actions";

function grantAdmin(allowed: boolean) {
  getCurrentUserMock.mockResolvedValue(allowed ? { id: "u1", email: "a@x.co" } : null);
  hasPermissionMock.mockReturnValue(allowed);
  readTokensMock.mockResolvedValue({ access: "tok", refresh: "r" });
}

beforeEach(() => vi.clearAllMocks());

describe("createUserAction — permission gate", () => {
  it("refuses a caller without user:admin and calls aw-auth with nothing", async () => {
    grantAdmin(false);
    const res = await createUserAction({
      email: "new@x.co",
      full_name: "New",
      password: "longenough1",
      roles: [],
    });
    expect(res.ok).toBe(false);
    expect(createUserMock).not.toHaveBeenCalled();
  });
});

describe("createUserAction — validation + forwarding", () => {
  beforeEach(() => grantAdmin(true));

  it("rejects a short password before calling aw-auth", async () => {
    const res = await createUserAction({
      email: "new@x.co",
      full_name: "New",
      password: "short",
      roles: [],
    });
    expect(res.ok).toBe(false);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it("forwards a valid payload with the access token and revalidates", async () => {
    createUserMock.mockResolvedValue({ ok: true, data: { id: "u2" } });
    const res = await createUserAction({
      email: "new@x.co",
      full_name: "New Person",
      password: "longenough1",
      roles: ["Viewer"],
    });
    expect(createUserMock).toHaveBeenCalledWith("tok", {
      email: "new@x.co",
      full_name: "New Person",
      password: "longenough1",
      roles: ["Viewer"],
    });
    expect(revalidateMock).toHaveBeenCalledWith("/admin/users");
    expect(res.ok).toBe(true);
  });

  it("surfaces aw-auth's error message on failure", async () => {
    createUserMock.mockResolvedValue({
      ok: false,
      status: 400,
      error: "user with this email already exists.",
    });
    const res = await createUserAction({
      email: "dup@x.co",
      full_name: "Dup",
      password: "longenough1",
      roles: [],
    });
    expect(res).toEqual({ ok: false, error: "user with this email already exists." });
  });
});

describe("updateUserAction", () => {
  beforeEach(() => grantAdmin(true));

  it("forwards the patch and revalidates both surfaces", async () => {
    updateUserMock.mockResolvedValue({ ok: true, data: {} });
    const res = await updateUserAction("u9", { roles: ["Admin"], is_active: true });
    expect(updateUserMock).toHaveBeenCalledWith("tok", "u9", {
      roles: ["Admin"],
      is_active: true,
    });
    expect(revalidateMock).toHaveBeenCalledWith("/admin/users/u9");
    expect(res.ok).toBe(true);
  });
});

describe("setUserPasswordAction", () => {
  beforeEach(() => grantAdmin(true));

  it("rejects mismatched passwords before calling aw-auth", async () => {
    const res = await setUserPasswordAction("u9", {
      new_password: "longenough1",
      confirm_password: "different22",
    });
    expect(res.ok).toBe(false);
    expect(setUserPasswordMock).not.toHaveBeenCalled();
  });

  it("forwards only the new password", async () => {
    setUserPasswordMock.mockResolvedValue({ ok: true, data: undefined });
    const res = await setUserPasswordAction("u9", {
      new_password: "longenough1",
      confirm_password: "longenough1",
    });
    expect(setUserPasswordMock).toHaveBeenCalledWith("tok", "u9", "longenough1");
    expect(res.ok).toBe(true);
  });
});

describe("deleteUserAction", () => {
  it("is blocked for a non-admin", async () => {
    grantAdmin(false);
    const res = await deleteUserAction("u9");
    expect(res.ok).toBe(false);
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it("surfaces the aw-auth guard message (last admin)", async () => {
    grantAdmin(true);
    deleteUserMock.mockResolvedValue({
      ok: false,
      status: 400,
      error: "This is the last administrator; assign another admin first.",
    });
    const res = await deleteUserAction("u9");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/last administrator/);
  });
});
