import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SSE stream (spec 19 / spec 34). Any signed-in user may connect. Events are
 * forwarded only when notificationVisibleTo would show them to that viewer.
 */

const { getUserMock, hasPermMock, countMock, subscribeMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  countMock: vi.fn(),
  subscribeMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/db/notifications", () => ({
  getUnreadCount: countMock,
}));
vi.mock("@/lib/notification-bus", () => ({
  subscribeNotifications: subscribeMock,
}));

import { GET } from "./route";

const admin = { id: "u1", email: "a@x.com" };
const tech = { id: "u2", email: "tech@x.com" };

function event(over: Record<string, unknown>) {
  return {
    id: "n",
    type: "ai-assist",
    severity: "info",
    title: "t",
    body: "b",
    href: "/x",
    assetId: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    audience: "user",
    recipientEmail: "tech@x.com",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue(admin);
  hasPermMock.mockReturnValue(true);
  countMock.mockResolvedValue(0);
  subscribeMock.mockImplementation(() => () => {});
});

function req(signal?: AbortSignal) {
  return new Request("http://localhost/api/notifications/stream", { signal });
}

async function readOne(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("sse timeout")), 500),
    ),
  ]);
  if (result.done) throw new Error("sse closed");
  return new TextDecoder().decode(result.value);
}

it("401 when signed out", async () => {
  getUserMock.mockResolvedValue(null);
  const res = await GET(req());
  expect(res.status).toBe(401);
  expect(subscribeMock).not.toHaveBeenCalled();
});

it("opens the stream for a signed-in non-admin", async () => {
  getUserMock.mockResolvedValue(tech);
  hasPermMock.mockReturnValue(false);
  const ac = new AbortController();
  try {
    const res = await GET(req(ac.signal));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await vi.waitFor(() => expect(subscribeMock).toHaveBeenCalled());
    expect(countMock).toHaveBeenCalledWith({
      userKey: "u2",
      email: "tech@x.com",
      isAdmin: false,
    });
  } finally {
    ac.abort();
  }
});

it("forwards only events visible to the connected user", async () => {
  getUserMock.mockResolvedValue(tech);
  hasPermMock.mockReturnValue(false);
  const ac = new AbortController();
  let listener: ((n: ReturnType<typeof event>) => void) | null = null;
  subscribeMock.mockImplementation((fn: (n: ReturnType<typeof event>) => void) => {
    listener = fn;
    return () => {};
  });

  try {
    const res = await GET(req(ac.signal));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(listener).not.toBeNull());
    const reader = res.body!.getReader();
    const count = await readOne(reader);
    expect(count).toContain("event: count");

    listener!({
      ...event({ id: "admins-row", audience: "admins", recipientEmail: null }),
    });
    listener!(event({ id: "other-user", recipientEmail: "someone@x.com" }));
    listener!(event({ id: "mine", recipientEmail: "Tech@x.com" }));

    const frame = await readOne(reader);
    expect(frame).toContain("event: notification");
    expect(frame).toContain("mine");
    expect(frame).not.toContain("admins-row");
    expect(frame).not.toContain("other-user");
  } finally {
    ac.abort();
  }
});

it("lets an admin receive broadcasts but not another user's private row", async () => {
  const ac = new AbortController();
  let listener: ((n: ReturnType<typeof event>) => void) | null = null;
  subscribeMock.mockImplementation((fn: (n: ReturnType<typeof event>) => void) => {
    listener = fn;
    return () => {};
  });

  try {
    const res = await GET(req(ac.signal));
    await vi.waitFor(() => expect(listener).not.toBeNull());
    const reader = res.body!.getReader();
    await readOne(reader);

    listener!(event({ id: "other-user", recipientEmail: "someone@x.com" }));
    listener!(event({ id: "broadcast", audience: "admins", recipientEmail: null }));
    listener!(event({ id: "own", recipientEmail: "A@x.com" }));

    const first = await readOne(reader);
    const second = await readOne(reader);
    expect(first).toContain("broadcast");
    expect(second).toContain("own");
    expect(first + second).not.toContain("other-user");
  } finally {
    ac.abort();
  }
});
