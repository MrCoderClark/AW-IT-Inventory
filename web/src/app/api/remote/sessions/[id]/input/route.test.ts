// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/remote/sessions/[id]/input (spec 24, AC-4/AC-5). Auth and the
 * DB are mocked. Locks the `remote:shell` gate and the ownership/active mapping.
 */
const { getUserMock, hasPermMock, appendInputMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  appendInputMock: vi.fn(),
}));

vi.mock("@/db/remote-sessions", () => ({ appendInput: appendInputMock }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));

import { POST } from "./route";

const ctx = (id = "s1") => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) =>
  new Request("http://localhost/api/remote/sessions/s1/input", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ email: "me@opus.local" });
  hasPermMock.mockReturnValue(true);
  appendInputMock.mockResolvedValue({ outcome: "ok", seq: 5 });
});

describe("POST /api/remote/sessions/[id]/input", () => {
  it("401 when signed out", async () => {
    getUserMock.mockResolvedValue(null);
    expect((await POST(req({ text: "x" }), ctx())).status).toBe(401);
  });

  it("403 without remote:shell", async () => {
    hasPermMock.mockReturnValue(false);
    expect((await POST(req({ text: "x" }), ctx())).status).toBe(403);
  });

  it("400 when text is not a string", async () => {
    expect((await POST(req({ text: 5 }), ctx())).status).toBe(400);
  });

  it("403 for a non-owner", async () => {
    appendInputMock.mockResolvedValue({ outcome: "forbidden" });
    expect((await POST(req({ text: "x" }), ctx())).status).toBe(403);
  });

  it("409 for a non-active session", async () => {
    appendInputMock.mockResolvedValue({ outcome: "not-active" });
    expect((await POST(req({ text: "x" }), ctx())).status).toBe(409);
  });

  it("200 with the new seq on success", async () => {
    const res = await POST(req({ text: "whoami" }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seq: 5 });
    expect(appendInputMock).toHaveBeenCalledWith("s1", "me@opus.local", "whoami");
  });
});
