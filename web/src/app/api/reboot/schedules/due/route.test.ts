import { describe, it, expect, beforeEach, vi } from "vitest";

const { materializeMock } = vi.hoisted(() => ({
  materializeMock: vi.fn(),
}));
vi.mock("@/db/reboot-schedules", () => ({
  materializeDueRebootSchedules: materializeMock,
}));
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

describe("POST /api/reboot/schedules/due", () => {
  it("401 without bearer", async () => {
    const res = await POST(
      new Request("http://localhost/api/reboot/schedules/due", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("403 with invalid token", async () => {
    const res = await POST(
      new Request("http://localhost/api/reboot/schedules/due", {
        method: "POST",
        headers: { Authorization: "Bearer bad" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("200 calls materializeDueRebootSchedules", async () => {
    materializeMock.mockResolvedValue({ checked: 3, created: 1 });
    const res = await POST(
      new Request("http://localhost/api/reboot/schedules/due", {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(materializeMock).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true, checked: 3, created: 1 });
  });
});
