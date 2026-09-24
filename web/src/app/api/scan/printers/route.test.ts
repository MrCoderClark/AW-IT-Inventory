import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for GET /api/scan/printers (spec 12). The service-token verification and
 * the DB read are mocked. Locks the auth gate (AC-9: no token -> 401, a token
 * missing scan:dequeue -> 403) and the target list the worker reads (AC-6).
 */

const { bearerFromMock, verifyMock, listMock } = vi.hoisted(() => ({
  bearerFromMock: vi.fn(),
  verifyMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerFromMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/db/reachability", () => ({ listPrinterTargets: listMock }));

import { GET } from "./route";

function req() {
  return new Request("http://localhost/api/scan/printers");
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/scan/printers — auth (AC-9)", () => {
  it("returns 401 when no bearer token is present", async () => {
    bearerFromMock.mockReturnValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the token lacks scan:dequeue", async () => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/scan/printers — list (AC-6)", () => {
  it("returns the printer targets for a valid service token", async () => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["scan:dequeue"] });
    listMock.mockResolvedValue([{ assetId: "a1", ipAddress: "10.0.0.5" }]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      printers: [{ assetId: "a1", ipAddress: "10.0.0.5" }],
    });
    expect(verifyMock).toHaveBeenCalledWith("tok", "scan:dequeue");
  });
});
