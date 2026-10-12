// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/remote/sessions/[id]/agent/output (spec 24, AC-4). Auth and
 * the DB are mocked. Locks the scope gate, the fence (409 on a stale claim), and
 * that one POST can mark active, append output, and finalize.
 */
const {
  bearerMock,
  verifyMock,
  markActiveMock,
  appendMock,
  finishMock,
} = vi.hoisted(() => ({
  bearerMock: vi.fn(),
  verifyMock: vi.fn(),
  markActiveMock: vi.fn(),
  appendMock: vi.fn(),
  finishMock: vi.fn(),
}));

vi.mock("@/db/remote-sessions", () => ({
  markSessionActive: markActiveMock,
  appendAgentEvents: appendMock,
  finishSession: finishMock,
}));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerMock,
  verifyServiceToken: verifyMock,
}));

import { POST } from "./route";

const ctx = (id = "s1") => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) =>
  new Request("http://localhost/api/remote/sessions/s1/agent/output", {
    method: "POST",
    body: JSON.stringify(body),
  });

const fence = { workerId: "w1", claimedAt: "2026-10-11T10:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  bearerMock.mockReturnValue("t");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["remote:agent"] });
  markActiveMock.mockResolvedValue("ok");
  appendMock.mockResolvedValue("ok");
  finishMock.mockResolvedValue("ok");
});

describe("POST /api/remote/sessions/[id]/agent/output", () => {
  it("403 without the remote:agent scope", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await POST(req({ ...fence }), ctx())).status).toBe(403);
  });

  it("400 without a fence", async () => {
    expect((await POST(req({ events: [] }), ctx())).status).toBe(400);
  });

  it("marks active, appends output, and finalizes in one call", async () => {
    const res = await POST(
      req({
        ...fence,
        status: "active",
        events: [{ channel: "stdout", data: "hi" }],
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(markActiveMock).toHaveBeenCalledWith("s1", fence);
    expect(appendMock).toHaveBeenCalledWith("s1", fence, [
      { channel: "stdout", data: "hi" },
    ]);
  });

  it("409 when the claim is stale on append", async () => {
    appendMock.mockResolvedValue("stale");
    const res = await POST(
      req({ ...fence, events: [{ channel: "stdout", data: "x" }] }),
      ctx(),
    );
    expect(res.status).toBe(409);
  });

  it("finalizes with failed + error", async () => {
    await POST(req({ ...fence, status: "failed", error: "boom" }), ctx());
    expect(finishMock).toHaveBeenCalledWith("s1", fence, "failed", "boom");
  });

  it("coerces unknown channels to stdout and caps data", async () => {
    await POST(
      req({ ...fence, events: [{ channel: "weird", data: "y" }] }),
      ctx(),
    );
    expect(appendMock).toHaveBeenCalledWith("s1", fence, [
      { channel: "stdout", data: "y" },
    ]);
  });
});
