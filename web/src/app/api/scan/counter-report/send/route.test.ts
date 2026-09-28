import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/scan/counter-report/send (spec 14). The service-token
 * verification and the shared report sender are mocked. Locks AC-7 (the auth
 * gate: no token -> 401, a token missing scan:dequeue -> 403) and AC-4 (a valid
 * service token triggers the send and returns the result shape).
 */

const { bearerFromMock, verifyMock, sendMock } = vi.hoisted(() => ({
  bearerFromMock: vi.fn(),
  verifyMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerFromMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/lib/counter-report", () => ({ sendCounterReport: sendMock }));

import { POST } from "./route";

function req() {
  return new Request("http://localhost/api/scan/counter-report/send", { method: "POST" });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/scan/counter-report/send — auth (AC-7)", () => {
  it("returns 401 when no bearer token is present", async () => {
    bearerFromMock.mockReturnValue(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the token lacks scan:dequeue", async () => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/scan/counter-report/send — send (AC-4)", () => {
  it("sends the report for a valid service token and returns the result", async () => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue({ sub: "collector" });
    sendMock.mockResolvedValue({ sent: true, printers: 3 });

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, printers: 3, sent: true });
    expect(verifyMock).toHaveBeenCalledWith("tok", "scan:dequeue");
    expect(sendMock).toHaveBeenCalledOnce();
  });
});
