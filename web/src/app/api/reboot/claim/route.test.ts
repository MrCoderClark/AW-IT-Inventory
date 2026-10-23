import { describe, it, expect, beforeEach, vi } from "vitest";

const { claimMock } = vi.hoisted(() => ({ claimMock: vi.fn() }));
vi.mock("@/db/reboot", () => ({ claimNextReboot: claimMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: (h: string | null) =>
    h?.startsWith("Bearer ") ? h.slice(7) : null,
  verifyServiceToken: vi.fn(async (t: string, scope: string) =>
    t === "tok" && scope === "deploy:agent" ? { sub: "collector" } : null,
  ),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/reboot/claim", () => {
  it("401 without bearer", async () => {
    const res = await POST(
      new Request("http://localhost/api/reboot/claim", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("204 when empty", async () => {
    claimMock.mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/reboot/claim", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workerId: "w1" }),
      }),
    );
    expect(res.status).toBe(204);
  });

  it("returns a claimed job", async () => {
    claimMock.mockResolvedValue({
      id: "j1",
      assetTag: "PC1",
      targetIp: "10.0.0.1",
      scheduledAt: "2026-10-22T18:00:00.000Z",
      sourcePatchInstallJobId: null,
      workerId: "w1",
      claimedAt: "t",
    });
    const res = await POST(
      new Request("http://localhost/api/reboot/claim", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workerId: "w1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "j1", assetTag: "PC1" });
  });
});
