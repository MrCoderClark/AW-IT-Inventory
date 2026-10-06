import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/scan/reachability/prune (spec 12 + spec 14). Auth, the
 * reachability prune, and the counter prune are mocked. Locks the auth gate
 * (AC-9), the reachability retention prune the worker's daily task calls
 * (AC-10), and the printer page-counter prune the same task drives (spec 14
 * AC-6): the given retention is passed through to both, and a missing one
 * defaults to 365.
 */

const {
  bearerFromMock,
  verifyMock,
  pruneMock,
  pruneCountersMock,
  pruneNotificationsMock,
} = vi.hoisted(() => ({
  bearerFromMock: vi.fn(),
  verifyMock: vi.fn(),
  pruneMock: vi.fn(),
  pruneCountersMock: vi.fn(),
  pruneNotificationsMock: vi.fn(),
}));

vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerFromMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/db/reachability", () => ({ pruneChecks: pruneMock }));
vi.mock("@/db/counters", () => ({ pruneCounters: pruneCountersMock }));
vi.mock("@/db/notifications", () => ({
  pruneNotifications: pruneNotificationsMock,
}));

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
  pruneCountersMock.mockResolvedValue(2);
  pruneNotificationsMock.mockResolvedValue(1);
});

describe("POST /api/scan/reachability/prune — auth (AC-9)", () => {
  it("returns 401 without a token", async () => {
    bearerFromMock.mockReturnValue(null);
    const res = await POST(req({ retentionDays: 365 }));
    expect(res.status).toBe(401);
    expect(pruneMock).not.toHaveBeenCalled();
    expect(pruneCountersMock).not.toHaveBeenCalled();
  });

  it("returns 403 without scan:dequeue", async () => {
    verifyMock.mockResolvedValue(null);
    const res = await POST(req({ retentionDays: 365 }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/scan/reachability/prune — prune (AC-10, spec 14 AC-6)", () => {
  it("prunes checks and counters with the given retention and returns both counts", async () => {
    const res = await POST(req({ retentionDays: 200 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      pruned: 4,
      prunedCounters: 2,
      prunedNotifications: 1,
    });
    expect(pruneMock).toHaveBeenCalledWith(200);
    expect(pruneCountersMock).toHaveBeenCalledWith(200);
    expect(pruneNotificationsMock).toHaveBeenCalled();
  });

  it("defaults retention to 365 for both prunes when not a number", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    expect(pruneMock).toHaveBeenCalledWith(365);
    expect(pruneCountersMock).toHaveBeenCalledWith(365);
  });
});
