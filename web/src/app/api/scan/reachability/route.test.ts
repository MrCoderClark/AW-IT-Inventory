import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/scan/reachability (spec 12). Auth, the reachability write,
 * and the alert send are mocked. Locks the auth gate (AC-9), the body validation
 * (a non-array checks -> 422, malformed entries dropped), and the alert flow
 * (AC-7): a transition fires one alert and advances state only when the send
 * succeeds, otherwise it stays pending to retry.
 */

const { bearerFromMock, verifyMock, recordMock, markMock, sendMock } = vi.hoisted(
  () => ({
    bearerFromMock: vi.fn(),
    verifyMock: vi.fn(),
    recordMock: vi.fn(),
    markMock: vi.fn(),
    sendMock: vi.fn(),
  }),
);

vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerFromMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/db/reachability", () => ({
  recordChecks: recordMock,
  markAlertSent: markMock,
}));
vi.mock("@/lib/notify", () => ({ sendPrinterAlert: sendMock }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/scan/reachability", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const okCheck = { assetId: "a1", reachable: false, method: "tcp", source: "manual" };

beforeEach(() => {
  vi.clearAllMocks();
  bearerFromMock.mockReturnValue("tok");
  verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["scan:dequeue"] });
  recordMock.mockResolvedValue([]);
});

describe("POST /api/scan/reachability — auth (AC-9)", () => {
  it("returns 401 without a token", async () => {
    bearerFromMock.mockReturnValue(null);
    const res = await POST(req({ checks: [okCheck] }));
    expect(res.status).toBe(401);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("returns 403 without scan:dequeue", async () => {
    verifyMock.mockResolvedValue(null);
    const res = await POST(req({ checks: [okCheck] }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/scan/reachability — validation", () => {
  it("returns 422 when checks is not an array", async () => {
    const res = await POST(req({ nope: true }));
    expect(res.status).toBe(422);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("drops malformed check entries and records only valid ones", async () => {
    const res = await POST(
      req({
        checks: [
          okCheck,
          { assetId: 5 }, // assetId not a string
          { assetId: "a2", reachable: true, method: "x", source: "manual" }, // bad method
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const passed = recordMock.mock.calls[0][0];
    expect(passed).toHaveLength(1);
    expect(passed[0]).toMatchObject({
      assetId: "a1",
      reachable: false,
      method: "tcp",
      source: "manual",
    });
    expect((await res.json()).recorded).toBe(1);
  });
});

describe("POST /api/scan/reachability — alerts (AC-7)", () => {
  const downEvent = {
    assetId: "a1",
    event: "down",
    name: "P",
    ip: "10.0.0.5",
    since: null,
  };

  it("fires an alert and advances state when the send succeeds", async () => {
    recordMock.mockResolvedValue([downEvent]);
    sendMock.mockResolvedValue(true);
    const res = await POST(req({ checks: [okCheck] }));
    const body = await res.json();
    expect(body.transitions).toBe(1);
    expect(body.alertsFired).toBe(1);
    expect(markMock).toHaveBeenCalledWith("a1", "down");
  });

  it("does not advance state when the send fails, so it retries", async () => {
    recordMock.mockResolvedValue([downEvent]);
    sendMock.mockResolvedValue(false);
    const res = await POST(req({ checks: [okCheck] }));
    const body = await res.json();
    expect(body.transitions).toBe(1);
    expect(body.alertsFired).toBe(0);
    expect(markMock).not.toHaveBeenCalled();
  });
});
