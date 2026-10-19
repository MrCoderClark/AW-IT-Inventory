import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/ingest/metrics (spec 29). The service-token verification and
 * the DB write are mocked. Locks the auth gate (no token -> 401, missing
 * scan:dequeue -> 403) and the sample parsing: camelCase asset id, ISO timestamp,
 * numeric gauges, and that a non-numeric gauge becomes null (a gap, never 0).
 */

const { bearerFromMock, verifyMock, recordMock, evaluateMock } = vi.hoisted(
  () => ({
    bearerFromMock: vi.fn(),
    verifyMock: vi.fn(),
    recordMock: vi.fn(),
    evaluateMock: vi.fn(),
  }),
);

vi.mock("@/lib/auth/service", () => ({
  bearerFrom: bearerFromMock,
  verifyServiceToken: verifyMock,
}));
vi.mock("@/db/metrics", () => ({ recordMetrics: recordMock }));
vi.mock("@/db/alert-rules", () => ({ evaluateMetricAlerts: evaluateMock }));

import { POST } from "./route";

function req(body?: unknown) {
  return new Request("http://localhost/api/ingest/metrics", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/ingest/metrics — auth", () => {
  it("401 without a bearer token", async () => {
    bearerFromMock.mockReturnValue(null);
    const res = await POST(req({ samples: [] }));
    expect(res.status).toBe(401);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("403 when the token lacks scan:dequeue", async () => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue(null);
    const res = await POST(req({ samples: [] }));
    expect(res.status).toBe(403);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest/metrics — parsing", () => {
  beforeEach(() => {
    bearerFromMock.mockReturnValue("tok");
    verifyMock.mockResolvedValue({ sub: "collector" });
    recordMock.mockResolvedValue(1);
  });

  it("400 when the body has no samples array", async () => {
    const res = await POST(req({ nope: true }));
    expect(res.status).toBe(400);
  });

  it("maps a sample and nulls a non-numeric gauge (a gap, not 0)", async () => {
    const res = await POST(
      req({
        samples: [
          {
            assetId: "a1",
            sampled_at: "2026-06-01T12:00:00.000Z",
            cpu_pct: 42,
            mem_pct: null,
            disk_pct: "oops",
            uptime_sec: 7200,
          },
          { ipAddress: "no asset id — dropped" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const [batch] = recordMock.mock.calls[0];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      assetId: "a1",
      cpuPct: 42,
      memPct: null,
      diskPct: null, // "oops" is not numeric → gap
      uptimeSec: 7200,
    });
    expect(batch[0].sampledAt).toBeInstanceOf(Date);
    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(evaluateMock.mock.calls[0][0]).toEqual(batch);
  });
});
