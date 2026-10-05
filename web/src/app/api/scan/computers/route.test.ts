import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for GET /api/scan/computers (scheduled computer sweep). The service-token
 * verification and the DB read are mocked. Locks the auth gate (no token -> 401, a
 * token missing scan:dequeue -> 403) and the target list the worker reads.
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
vi.mock("@/db/queries", () => ({ listComputerScanTargets: listMock }));

import { GET } from "./route";

function req() {
  return new Request("http://localhost/api/scan/computers");
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/scan/computers — auth", () => {
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

describe("GET /api/scan/computers — list", () => {
  it("returns the manually-entered computer targets for a valid service token", async () => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue({ clientId: "collector", scopes: ["scan:dequeue"] });
    listMock.mockResolvedValue([{ assetId: "a1", ipAddress: "192.168.70.7" }]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      computers: [{ assetId: "a1", ipAddress: "192.168.70.7" }],
    });
    expect(verifyMock).toHaveBeenCalledWith("tok", "scan:dequeue");
  });
});
