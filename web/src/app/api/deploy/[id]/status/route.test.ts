// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/deploy/[id]/status (spec 23, AC-6). Auth + the fenced update
 * are mocked. Locks the scope gate, fence→validation, and the 404/409/200 mapping.
 */
const { bearerMock, verifyMock, updateMock } = vi.hoisted(() => ({
  bearerMock: vi.fn(),
  verifyMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("@/db/software-deploy", () => ({ updateDeploymentStatus: updateMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerMock,
  verifyServiceToken: verifyMock,
}));

import { POST } from "./route";

const ctx = (id = "d1") => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) =>
  new Request("http://localhost/api/deploy/d1/status", {
    method: "POST",
    body: JSON.stringify(body),
  });

const fence = { workerId: "w1", claimedAt: "2026-10-12T10:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  bearerMock.mockReturnValue("t");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["deploy:agent"] });
  updateMock.mockResolvedValue("ok");
});

describe("POST /api/deploy/[id]/status", () => {
  it("403 without the deploy:agent scope", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await POST(req({ ...fence, status: "running" }), ctx())).status).toBe(403);
  });

  it("400 on an invalid status", async () => {
    expect((await POST(req({ ...fence, status: "weird" }), ctx())).status).toBe(400);
  });

  it("404 when the deployment is unknown", async () => {
    updateMock.mockResolvedValue("notfound");
    expect((await POST(req({ ...fence, status: "running" }), ctx())).status).toBe(404);
  });

  it("409 on a stale claim", async () => {
    updateMock.mockResolvedValue("stale");
    expect((await POST(req({ ...fence, status: "succeeded" }), ctx())).status).toBe(409);
  });

  it("200 and passes the result through on success", async () => {
    const result = { outcome: "installed", rebootRequired: false, steps: [] };
    const res = await POST(req({ ...fence, status: "succeeded", result }), ctx());
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "succeeded", result }),
    );
  });
});
