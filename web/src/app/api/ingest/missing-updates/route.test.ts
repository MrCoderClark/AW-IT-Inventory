import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  replaceMissingUpdates: vi.fn(async () => undefined),
  verifyServiceToken: vi.fn(async () => ({ sub: "collector" })),
  bearerFrom: vi.fn((h: string | null) =>
    h?.startsWith("Bearer ") ? h.slice(7) : null,
  ),
}));

vi.mock("@/db/patches", () => ({
  replaceMissingUpdates: H.replaceMissingUpdates,
}));
vi.mock("@/lib/auth/service", () => ({
  bearerFrom: H.bearerFrom,
  verifyServiceToken: H.verifyServiceToken,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  H.verifyServiceToken.mockResolvedValue({ sub: "collector" });
});

function req(body: unknown, auth = "Bearer tok") {
  return new Request("http://localhost/api/ingest/missing-updates", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ingest/missing-updates", () => {
  it("rejects missing bearer", async () => {
    const res = await POST(req({ results: [] }, ""));
    expect(res.status).toBe(401);
  });

  it("rejects without scan:dequeue", async () => {
    H.verifyServiceToken.mockResolvedValueOnce(null);
    const res = await POST(req({ results: [] }));
    expect(res.status).toBe(403);
  });

  it("records each result via replaceMissingUpdates", async () => {
    const res = await POST(
      req({
        results: [
          {
            assetId: "a1",
            collected_at: "2026-10-19T18:00:00Z",
            count: 1,
            missing: [
              {
                kb: "KB5034441",
                title: "Security Update",
                severity: "Critical",
                size_bytes: 100,
              },
            ],
          },
          { assetId: "a2", missing: [] },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.recorded).toBe(2);
    expect(H.replaceMissingUpdates).toHaveBeenCalledTimes(2);
    expect(H.replaceMissingUpdates.mock.calls[0][0]).toBe("a1");
    expect(H.replaceMissingUpdates.mock.calls[0][1]).toEqual([
      {
        kb: "KB5034441",
        title: "Security Update",
        severity: "Critical",
        size_bytes: 100,
      },
    ]);
    expect(H.replaceMissingUpdates.mock.calls[1][1]).toEqual([]);
  });
});
