import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for GET /api/notifications (spec 19). Auth/session and the data layer are
 * mocked. Locks the admin gate (AC-6): a signed-out user gets 401, a non-admin
 * 403, an admin gets the feed + unread count.
 */

const { getUserMock, hasPermMock, listMock, countMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  listMock: vi.fn(),
  countMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/db/notifications", () => ({
  listNotifications: listMock,
  getUnreadCount: countMock,
}));

import { GET } from "./route";

const admin = { id: "u1", email: "a@x.com" };

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue(admin);
  hasPermMock.mockReturnValue(true);
  listMock.mockResolvedValue({ items: [{ id: "n1" }], nextBefore: null });
  countMock.mockResolvedValue(1);
});

function req(qs = "") {
  return new Request(`http://localhost/api/notifications${qs}`);
}

it("401 when signed out", async () => {
  getUserMock.mockResolvedValue(null);
  const res = await GET(req());
  expect(res.status).toBe(401);
  expect(listMock).not.toHaveBeenCalled();
});

it("403 for a non-admin", async () => {
  hasPermMock.mockReturnValue(false);
  const res = await GET(req());
  expect(res.status).toBe(403);
  expect(listMock).not.toHaveBeenCalled();
});

it("returns the feed and unread count for an admin", async () => {
  const res = await GET(req("?limit=10"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    items: [{ id: "n1" }],
    nextBefore: null,
    unread: 1,
  });
  expect(hasPermMock).toHaveBeenCalledWith(admin, "user:admin");
  expect(listMock).toHaveBeenCalledWith("u1", {
    limit: 10,
    before: undefined,
    unreadOnly: false,
  });
});
