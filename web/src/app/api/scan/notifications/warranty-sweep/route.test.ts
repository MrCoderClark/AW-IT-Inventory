import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for POST /api/scan/notifications/warranty-sweep (spec 19, AC-5). Auth and
 * the sweep are mocked. Locks the service-scope gate and the pass-through of the
 * created count.
 */

const { bearerFromMock, verifyMock, sweepMock } = vi.hoisted(() => ({
  bearerFromMock: vi.fn(),
  verifyMock: vi.fn(),
  sweepMock: vi.fn(),
}));

vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerFromMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/db/notifications", () => ({ sweepWarrantyNotifications: sweepMock }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/scan/notifications/warranty-sweep", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bearerFromMock.mockReturnValue("tok");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["scan:dequeue"] });
  sweepMock.mockResolvedValue(3);
});

describe("auth", () => {
  it("401 without a token", async () => {
    bearerFromMock.mockReturnValue(null);
    const res = await POST(req({}));
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("403 without scan:dequeue", async () => {
    verifyMock.mockResolvedValue(null);
    const res = await POST(req({}));
    expect(res.status).toBe(403);
    expect(sweepMock).not.toHaveBeenCalled();
  });
});

describe("sweep", () => {
  it("runs the sweep and returns the created count", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 3 });
    expect(sweepMock).toHaveBeenCalledWith({ withinDays: undefined });
  });

  it("passes a valid withinDays through", async () => {
    await POST(req({ withinDays: 60 }));
    expect(sweepMock).toHaveBeenCalledWith({ withinDays: 60 });
  });
});
