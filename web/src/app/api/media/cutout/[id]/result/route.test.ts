// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/media/cutout/[id]/result (spec 18 phase 3). Auth, the DB
 * completion, and storage are mocked. Locks the scope gate, the done/failed paths,
 * and the 409 when the claim was lost (completeCutout returns ok:false).
 */
const { bearerMock, verifyMock, completeMock, storageMock, revalidateMock } =
  vi.hoisted(() => ({
    bearerMock: vi.fn(),
    verifyMock: vi.fn(),
    completeMock: vi.fn(),
    storageMock: vi.fn(),
    revalidateMock: vi.fn(),
  }));

vi.mock("@/db/media", () => ({ completeCutout: completeMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/lib/storage", () => ({ isStorageConfigured: storageMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { POST } from "./route";

const ctx = (id = "m1") => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) =>
  new Request("http://localhost/api/media/cutout/m1/result", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.mockReturnValue(true);
  bearerMock.mockReturnValue("t");
  verifyMock.mockResolvedValue({ clientId: "c", scopes: ["scan:dequeue"] });
});

describe("POST /api/media/cutout/[id]/result", () => {
  it("403 without scan:dequeue", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await POST(req({ workerId: "w1", status: "failed" }), ctx())).status).toBe(403);
  });

  it("stores a successful cut-out (done)", async () => {
    completeMock.mockResolvedValue({ ok: true });
    const b64 = Buffer.from("png").toString("base64");
    const res = await POST(req({ workerId: "w1", status: "done", cutoutB64: b64 }), ctx());
    expect(res.status).toBe(200);
    expect(completeMock).toHaveBeenCalledWith("m1", "w1", {
      ok: true,
      cutoutBytes: expect.any(Buffer),
    });
  });

  it("records a failed job", async () => {
    completeMock.mockResolvedValue({ ok: true });
    const res = await POST(req({ workerId: "w1", status: "failed" }), ctx());
    expect(res.status).toBe(200);
    expect(completeMock).toHaveBeenCalledWith("m1", "w1", { ok: false });
  });

  it("409 when the claim was lost", async () => {
    completeMock.mockResolvedValue({ ok: false });
    const res = await POST(req({ workerId: "w1", status: "failed" }), ctx());
    expect(res.status).toBe(409);
  });

  it("400 when a done result has no bytes", async () => {
    const res = await POST(req({ workerId: "w1", status: "done" }), ctx());
    expect(res.status).toBe(400);
    expect(completeMock).not.toHaveBeenCalled();
  });
});
