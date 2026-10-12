// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/deploy/prune (spec 23). Auth and the DB are mocked. Locks the
 * `deploy:agent` scope gate and the cutoff passed to the prune.
 */
const { bearerMock, verifyMock, pruneMock } = vi.hoisted(() => ({
  bearerMock: vi.fn(),
  verifyMock: vi.fn(),
  pruneMock: vi.fn(),
}));

vi.mock("@/db/software-deploy", () => ({ pruneDeployments: pruneMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerMock,
  verifyServiceToken: verifyMock,
}));

import { POST } from "./route";

const req = (body: unknown = { retentionDays: 90 }) =>
  new Request("http://localhost/api/deploy/prune", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  bearerMock.mockReturnValue("t");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["deploy:agent"] });
  pruneMock.mockResolvedValue(4);
});

describe("POST /api/deploy/prune", () => {
  it("403 without the deploy:agent scope", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(403);
  });

  it("prunes with a cutoff and returns the count", async () => {
    const res = await POST(req({ retentionDays: 30 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pruned: 4 });
    const cutoff = pruneMock.mock.calls[0][0] as Date;
    const days = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("defaults to 90 days on a non-positive value", async () => {
    await POST(req({ retentionDays: 0 }));
    const cutoff = pruneMock.mock.calls[0][0] as Date;
    const days = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89.9);
  });
});
