import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/scan/reachability/prune (spec 12). Auth and the prune are
 * mocked. Locks the auth gate (AC-9) and the retention prune the worker's daily
 * task calls (AC-10): the given retention is passed through, and a missing one
 * defaults to 365.
 */

const { bearerFromMock, verifyMock, pruneMock } = vi.hoisted(() => ({
  bearerFromMock: vi.fn(),
  verifyMock: vi.fn(),
  pruneMock: vi.fn(),
}));

vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerFromMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/db/reachability", () => ({ pruneChecks: pruneMock }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/scan/reachability/prune", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bearerFromMock.mockReturnValue("tok");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["scan:dequeue"] });
  pruneMock.mockResolvedValue(4);
});

describe("POST /api/scan/reachability/prune — auth (AC-9)", () => {
  it("returns 401 without a token", async () => {
    bearerFromMock.mockReturnValue(null);
    const res = await POST(req({ retentionDays: 365 }));
    expect(res.status).toBe(401);
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it("returns 403 without scan:dequeue", async () => {
    verifyMock.mockResolvedValue(null);
    const res = await POST(req({ retentionDays: 365 }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/scan/reachability/prune — prune (AC-10)", () => {
  it("prunes with the given retention and returns the count", async () => {
    const res = await POST(req({ retentionDays: 200 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pruned: 4 });
    expect(pruneMock).toHaveBeenCalledWith(200);
  });

  it("defaults retention to 365 when not a number", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    expect(pruneMock).toHaveBeenCalledWith(365);
  });
});
