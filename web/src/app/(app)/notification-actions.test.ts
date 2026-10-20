import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Notification server actions (spec 34). Any signed-in user may mark read;
 * the viewer passed to the data layer carries isAdmin so mark-all stays scoped.
 */

const { getUserMock, hasPermMock, markReadMock, markAllMock, revalidateMock } =
  vi.hoisted(() => ({
    getUserMock: vi.fn(),
    hasPermMock: vi.fn(),
    markReadMock: vi.fn(),
    markAllMock: vi.fn(),
    revalidateMock: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/db/notifications", () => ({
  markRead: markReadMock,
  markAllRead: markAllMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "./notification-actions";

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ id: "u2", email: "tech@x.com" });
  hasPermMock.mockImplementation(
    (_user: unknown, perm: string) => perm === "user:admin" && false,
  );
  markReadMock.mockResolvedValue(1);
  markAllMock.mockResolvedValue(0);
});

describe("notification actions", () => {
  it("refuses a signed-out user", async () => {
    getUserMock.mockResolvedValue(null);
    const res = await markAllNotificationsReadAction();
    expect(res.ok).toBe(false);
    expect(markAllMock).not.toHaveBeenCalled();
  });

  it("lets a non-admin mark all read with isAdmin false", async () => {
    hasPermMock.mockReturnValue(false);
    const res = await markAllNotificationsReadAction();
    expect(res.ok).toBe(true);
    expect(markAllMock).toHaveBeenCalledWith({
      userKey: "u2",
      email: "tech@x.com",
      isAdmin: false,
    });
  });

  it("lets a non-admin mark one notification read", async () => {
    hasPermMock.mockReturnValue(false);
    const res = await markNotificationReadAction("n1");
    expect(res.ok).toBe(true);
    expect(markReadMock).toHaveBeenCalledWith(
      { userKey: "u2", email: "tech@x.com", isAdmin: false },
      "n1",
    );
  });
});
