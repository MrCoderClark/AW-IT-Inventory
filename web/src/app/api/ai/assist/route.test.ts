import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/ai/assist (spec 34 v2a). Auth and the job queue are mocked.
 * The handler must return 202 without running the provider in the request.
 */

const { getUserMock, hasPermMock, enqueueMock, processMock, afterMock } =
  vi.hoisted(() => ({
    getUserMock: vi.fn(),
    hasPermMock: vi.fn(),
    enqueueMock: vi.fn(),
    processMock: vi.fn(),
    afterMock: vi.fn(),
  }));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: afterMock };
});
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/db/ai-assist-jobs", () => ({
  enqueueAssistJob: enqueueMock,
  processAssistJob: processMock,
}));

import { POST } from "./route";

const user = { id: "u1", email: "me@opus.local", permissions: ["asset:read"] };

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue(user);
  hasPermMock.mockImplementation(
    (_user: unknown, perm: string) => perm === "asset:read",
  );
  enqueueMock.mockResolvedValue({ id: "job-1" });
  processMock.mockResolvedValue(undefined);
});

function req(body: unknown) {
  return new Request("http://localhost/api/ai/assist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/assist", () => {
  it("401 when signed out", async () => {
    getUserMock.mockResolvedValue(null);
    const res = await POST(req({ action: "summarize_health", assetTag: "PC-1" }));
    expect(res.status).toBe(401);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("400 when action or assetTag is missing", async () => {
    const res = await POST(req({ action: "nope", assetTag: "  " }));
    expect(res.status).toBe(400);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("403 for summaries without asset:read", async () => {
    hasPermMock.mockReturnValue(false);
    const res = await POST(req({ action: "summarize_health", assetTag: "PC-1" }));
    expect(res.status).toBe(403);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("403 for draft_script without software:deploy", async () => {
    const res = await POST(req({ action: "draft_script", assetTag: "PC-1" }));
    expect(res.status).toBe(403);
    expect(hasPermMock).toHaveBeenCalledWith(user, "software:deploy");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("503 when AI is not configured and does not schedule work", async () => {
    enqueueMock.mockResolvedValue({ error: "not_configured" });
    const res = await POST(req({ action: "summarize_health", assetTag: "PC-1" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "AI not configured",
      code: "ai_not_configured",
    });
    expect(afterMock).not.toHaveBeenCalled();
    expect(processMock).not.toHaveBeenCalled();
  });

  it("404 when the computer is missing", async () => {
    enqueueMock.mockResolvedValue({ error: "not_found" });
    const res = await POST(req({ action: "explain_failures", assetTag: "PC-9" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Computer not found" });
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("202 with jobId and runs process only from the after callback", async () => {
    let scheduled: (() => unknown) | undefined;
    afterMock.mockImplementation((cb: () => unknown) => {
      scheduled = cb;
    });

    const res = await POST(
      req({
        action: "summarize_script_run",
        assetTag: " PC-1 ",
        jobId: "run-9",
        userPrompt: "why did it fail",
      }),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: "job-1" });
    expect(enqueueMock).toHaveBeenCalledWith({
      action: "summarize_script_run",
      assetTag: "PC-1",
      actorEmail: "me@opus.local",
      scriptRunJobId: "run-9",
      userPrompt: "why did it fail",
    });
    expect(processMock).not.toHaveBeenCalled();
    expect(scheduled).toBeTypeOf("function");
    scheduled?.();
    expect(processMock).toHaveBeenCalledTimes(1);
    expect(processMock).toHaveBeenCalledWith("job-1");
  });
});
