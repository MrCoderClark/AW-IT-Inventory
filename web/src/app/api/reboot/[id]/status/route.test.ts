import { describe, it, expect, beforeEach, vi } from "vitest";

const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));
vi.mock("@/db/reboot", () => ({ updateRebootStatus: updateMock }));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: (h: string | null) =>
    h?.startsWith("Bearer ") ? h.slice(7) : null,
  verifyServiceToken: vi.fn(async (t: string, scope: string) =>
    t === "tok" && scope === "deploy:agent" ? { sub: "collector" } : null,
  ),
}));

import { POST } from "./route";

const JID = "0959927f-1046-4582-9a70-60a4175f206b";

function req(body: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/reboot/${JID}/status`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: JID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/reboot/[id]/status", () => {
  it("401 without bearer", async () => {
    const res = await POST(
      new Request(`http://localhost/api/reboot/${JID}/status`, {
        method: "POST",
        body: "{}",
      }),
      { params: Promise.resolve({ id: JID }) },
    );
    expect(res.status).toBe(401);
  });

  it("409 on stale claim", async () => {
    updateMock.mockResolvedValue("stale");
    const res = await req({
      workerId: "w1",
      claimedAt: "2026-10-19T10:00:00.000Z",
      status: "running",
    });
    expect(res.status).toBe(409);
  });

  it("404 when job missing", async () => {
    updateMock.mockResolvedValue("notfound");
    const res = await req({
      workerId: "w1",
      claimedAt: "2026-10-19T10:00:00.000Z",
      status: "succeeded",
    });
    expect(res.status).toBe(404);
  });

  it("returns ok on fenced update", async () => {
    updateMock.mockResolvedValue("ok");
    const res = await req({
      workerId: "w1",
      claimedAt: "2026-10-19T10:00:00.000Z",
      status: "succeeded",
      result: { ok: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledWith(JID, {
      workerId: "w1",
      claimedAt: "2026-10-19T10:00:00.000Z",
      status: "succeeded",
      result: { ok: true },
    });
  });
});
