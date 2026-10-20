import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/ai/assist/[jobId] (spec 34 v2a). Auth and the job row are mocked.
 * The requester or a user:admin may read the job; anyone else is 403.
 */

const { getUserMock, hasPermMock, getJobMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  getJobMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/db/ai-assist-jobs", () => ({
  getAssistJob: getJobMock,
}));

import { GET } from "./route";

const requester = { id: "u1", email: "me@opus.local", permissions: ["asset:read"] };
const createdAt = new Date("2026-10-20T12:00:00.000Z");
const finishedAt = new Date("2026-10-20T12:01:00.000Z");

const job = {
  id: "job-1",
  status: "succeeded" as const,
  action: "summarize_health",
  result: { observed: ["ok"], hypotheses: [], recommendations: [] },
  error: null,
  createdAt,
  startedAt: createdAt,
  finishedAt,
  actorEmail: "me@opus.local",
  assetId: "asset-1",
};

const ctx = (jobId = "job-1") => ({ params: Promise.resolve({ jobId }) });
const req = () => new Request("http://localhost/api/ai/assist/job-1");

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue(requester);
  hasPermMock.mockReturnValue(false);
  getJobMock.mockResolvedValue(job);
});

describe("GET /api/ai/assist/[jobId]", () => {
  it("401 when signed out", async () => {
    getUserMock.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it("404 when the job is missing", async () => {
    getJobMock.mockResolvedValue(null);
    const res = await GET(req(), ctx("missing"));
    expect(res.status).toBe(404);
    expect(getJobMock).toHaveBeenCalledWith("missing");
  });

  it("403 for a different user who is not an admin", async () => {
    getUserMock.mockResolvedValue({ ...requester, email: "other@opus.local" });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    expect(hasPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: "other@opus.local" }),
      "user:admin",
    );
  });

  it("200 for the requester", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "job-1",
      status: "succeeded",
      action: "summarize_health",
      result: job.result,
      error: null,
      createdAt: createdAt.toISOString(),
      startedAt: createdAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      actorEmail: "me@opus.local",
      assetId: "asset-1",
    });
  });

  it("200 for the requester when email casing differs", async () => {
    getUserMock.mockResolvedValue({
      ...requester,
      email: "Me@Opus.Local",
    });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
  });

  it("200 for an admin who did not request the job", async () => {
    const admin = { ...requester, email: "admin@opus.local" };
    getUserMock.mockResolvedValue(admin);
    hasPermMock.mockImplementation(
      (_user: unknown, perm: string) => perm === "user:admin",
    );
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("job-1");
  });
});
