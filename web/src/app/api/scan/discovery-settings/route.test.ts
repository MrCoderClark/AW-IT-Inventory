import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for GET /api/scan/discovery-settings (spec 13). The service-token
 * verification and the DB read are mocked. Locks in AC-7 (the auth gate: no
 * token -> 401, a token missing scan:dequeue -> 403) and AC-3/AC-2 (a valid
 * service token gets the settings shape).
 */

const { bearerFromMock, verifyMock, getSettingsMock } = vi.hoisted(() => ({
  bearerFromMock: vi.fn(),
  verifyMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerFromMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/db/discovery", () => ({ getDiscoverySettings: getSettingsMock }));

import { GET } from "./route";

function req() {
  return new Request("http://localhost/api/scan/discovery-settings");
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/scan/discovery-settings — auth (AC-7)", () => {
  it("returns 401 when no bearer token is present", async () => {
    bearerFromMock.mockReturnValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the token lacks scan:dequeue", async () => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(getSettingsMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/scan/discovery-settings — read (AC-3, AC-2)", () => {
  it("returns the settings shape for a valid service token", async () => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue({ sub: "collector" });
    getSettingsMock.mockResolvedValue({ computer: true, printer: false });

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ computer: true, printer: false });
    expect(verifyMock).toHaveBeenCalledWith("tok", "scan:dequeue");
  });
});
