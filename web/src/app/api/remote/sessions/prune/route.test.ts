// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/remote/sessions/prune (spec 24, AC-7). Auth and the DB are
 * mocked. Locks the `remote:agent` scope gate and the cutoff passed to the prune.
 */
const { bearerMock, verifyMock, pruneMock } = vi.hoisted(() => ({
  bearerMock: vi.fn(),
  verifyMock: vi.fn(),
  pruneMock: vi.fn(),
}));

vi.mock("@/db/remote-sessions", () => ({ pruneRemoteSessionEvents: pruneMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerMock,
  verifyServiceToken: verifyMock,
}));

import { POST } from "./route";

const req = (body: unknown = { retentionDays: 30 }) =>
  new Request("http://localhost/api/remote/sessions/prune", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  bearerMock.mockReturnValue("t");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["remote:agent"] });
  pruneMock.mockResolvedValue(7);
});

describe("POST /api/remote/sessions/prune", () => {
  it("403 without the remote:agent scope", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(403);
  });

  it("prunes with a cutoff and returns the count", async () => {
    const res = await POST(req({ retentionDays: 10 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pruned: 7 });
    const cutoff = pruneMock.mock.calls[0][0] as Date;
    const days = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(9.9);
    expect(days).toBeLessThan(10.1);
  });

  it("defaults to 30 days on a non-positive value", async () => {
    await POST(req({ retentionDays: 0 }));
    const cutoff = pruneMock.mock.calls[0][0] as Date;
    const days = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
  });
});
