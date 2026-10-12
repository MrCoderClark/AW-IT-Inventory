// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/remote/sessions/claim (spec 24, AC-3/AC-8). Auth and the DB
 * claim are mocked. Locks the `remote:agent` scope gate, the empty-queue 204, and a
 * claimed-session payload.
 */
const { bearerMock, verifyMock, claimMock } = vi.hoisted(() => ({
  bearerMock: vi.fn(),
  verifyMock: vi.fn(),
  claimMock: vi.fn(),
}));

vi.mock("@/db/remote-sessions", () => ({ claimNextRemoteSession: claimMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerMock,
  verifyServiceToken: verifyMock,
}));

import { POST } from "./route";

const req = (body: unknown = { workerId: "w1" }) =>
  new Request("http://localhost/api/remote/sessions/claim", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  bearerMock.mockReturnValue("t");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["remote:agent"] });
});

describe("POST /api/remote/sessions/claim", () => {
  it("401 without a bearer token", async () => {
    bearerMock.mockReturnValue(null);
    expect((await POST(req())).status).toBe(401);
  });

  it("403 without the remote:agent scope", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(403);
    expect(verifyMock).toHaveBeenCalledWith("t", "remote:agent");
  });

  it("400 when workerId is missing", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });

  it("204 when the queue is empty", async () => {
    claimMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(204);
  });

  it("returns the claimed session", async () => {
    const session = {
      id: "s1",
      assetTag: "PC-1",
      targetIp: "192.168.70.5",
      shell: "powershell",
      workerId: "w1",
      claimedAt: "2026-10-11T10:00:00.000Z",
    };
    claimMock.mockResolvedValue(session);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(session);
  });
});
