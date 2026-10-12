// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for GET /api/remote/sessions/[id]/transcript (spec 24, AC-7). Auth + the DB
 * are mocked. Locks the `remote:shell` gate, ownership, and the events payload.
 */
const { getUserMock, hasPermMock, getSessionMock, readEventsMock } = vi.hoisted(
  () => ({
    getUserMock: vi.fn(),
    hasPermMock: vi.fn(),
    getSessionMock: vi.fn(),
    readEventsMock: vi.fn(),
  }),
);

vi.mock("@/db/remote-sessions", () => ({
  getRemoteSession: getSessionMock,
  readEventsAfter: readEventsMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));

import { GET } from "./route";

const ctx = (id = "s1") => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://localhost/api/remote/sessions/s1/transcript");

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ email: "me@opus.local" });
  hasPermMock.mockReturnValue(true);
  getSessionMock.mockResolvedValue({ requestedBy: "me@opus.local" });
  readEventsMock.mockResolvedValue([
    { seq: 1, direction: "input", channel: null, data: "whoami" },
    { seq: 2, direction: "output", channel: "stdout", data: "opus\\me" },
  ]);
});

describe("GET /api/remote/sessions/[id]/transcript", () => {
  it("403 without remote:shell", async () => {
    hasPermMock.mockReturnValue(false);
    expect((await GET(req(), ctx())).status).toBe(403);
  });

  it("404 for an unknown session", async () => {
    getSessionMock.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(404);
  });

  it("403 for a non-owner", async () => {
    getSessionMock.mockResolvedValue({ requestedBy: "someone-else" });
    expect((await GET(req(), ctx())).status).toBe(403);
  });

  it("returns the recorded events for the owner", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({ direction: "input", data: "whoami" });
  });
});
