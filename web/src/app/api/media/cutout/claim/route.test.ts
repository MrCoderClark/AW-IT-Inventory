// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/media/cutout/claim (spec 18 phase 3). Auth, the DB claim, and
 * storage are mocked. Locks the service-scope gate, the empty-queue 204, and that a
 * claimed job returns the original bytes inline (base64) for the outbound worker.
 */
const { bearerMock, verifyMock, claimMock, getBytesMock, storageMock } = vi.hoisted(
  () => ({
    bearerMock: vi.fn(),
    verifyMock: vi.fn(),
    claimMock: vi.fn(),
    getBytesMock: vi.fn(),
    storageMock: vi.fn(),
  }),
);

vi.mock("@/db/media", () => ({ claimCutoutJob: claimMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/lib/storage", () => ({
  getImageBytes: getBytesMock,
  isStorageConfigured: storageMock,
}));

import { POST } from "./route";

const req = (body: unknown = { workerId: "w1" }) =>
  new Request("http://localhost/api/media/cutout/claim", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.mockReturnValue(true);
});

describe("POST /api/media/cutout/claim", () => {
  it("401 without a bearer token", async () => {
    bearerMock.mockReturnValue(null);
    expect((await POST(req())).status).toBe(401);
  });

  it("403 without scan:dequeue", async () => {
    bearerMock.mockReturnValue("t");
    verifyMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(403);
  });

  it("400 when workerId is missing", async () => {
    bearerMock.mockReturnValue("t");
    verifyMock.mockResolvedValue({ clientId: "c", scopes: ["scan:dequeue"] });
    expect((await POST(req({}))).status).toBe(400);
  });

  it("204 when the queue is empty", async () => {
    bearerMock.mockReturnValue("t");
    verifyMock.mockResolvedValue({ clientId: "c", scopes: ["scan:dequeue"] });
    claimMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(204);
  });

  it("returns the claimed job's original bytes as base64", async () => {
    bearerMock.mockReturnValue("t");
    verifyMock.mockResolvedValue({ clientId: "c", scopes: ["scan:dequeue"] });
    claimMock.mockResolvedValue({
      mediaId: "m1",
      objectKey: "media/m1/image.png",
      contentType: "image/png",
    });
    getBytesMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mediaId).toBe("m1");
    expect(Buffer.from(data.imageB64, "base64")).toEqual(Buffer.from([1, 2, 3]));
  });
});
