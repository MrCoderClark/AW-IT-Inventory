// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/deploy/claim (spec 23, AC-3). Auth + the DB claim are mocked.
 * Locks the `deploy:agent` scope gate, the empty-queue 204, and a claimed payload.
 */
const { bearerMock, verifyMock, claimMock } = vi.hoisted(() => ({
  bearerMock: vi.fn(),
  verifyMock: vi.fn(),
  claimMock: vi.fn(),
}));

vi.mock("@/db/software-deploy", () => ({ claimNextDeployment: claimMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerMock,
  verifyServiceToken: verifyMock,
}));

import { POST } from "./route";

const req = (body: unknown = { workerId: "w1" }) =>
  new Request("http://localhost/api/deploy/claim", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  bearerMock.mockReturnValue("t");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["deploy:agent"] });
});

describe("POST /api/deploy/claim", () => {
  it("403 without the deploy:agent scope", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(403);
    expect(verifyMock).toHaveBeenCalledWith("t", "deploy:agent");
  });

  it("400 when workerId is missing", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });

  it("204 when the queue is empty", async () => {
    claimMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(204);
  });

  it("returns the claimed deployment", async () => {
    const job = {
      id: "d1",
      assetTag: "PC-1",
      targetIp: "192.168.70.5",
      packageSnapshot: { name: "App", version: "1", steps: [] },
      workerId: "w1",
      claimedAt: "2026-10-12T10:00:00.000Z",
    };
    claimMock.mockResolvedValue(job);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(job);
  });
});
