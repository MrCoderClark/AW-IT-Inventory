// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for PUT /api/software/packages/[id] (spec 23 edit). Auth, the catalog DB,
 * and storage are mocked. Locks the `software:deploy` gate, dup check (self-
 * excluded), 404/409/200 mapping, and orphan-file cleanup.
 */
const { getUserMock, hasPermMock, existsMock, updateMock, removeObjMock } =
  vi.hoisted(() => ({
    getUserMock: vi.fn(),
    hasPermMock: vi.fn(),
    existsMock: vi.fn(),
    updateMock: vi.fn(),
    removeObjMock: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/db/software-packages", () => ({
  updateSoftwarePackage: updateMock,
  softwarePackageExists: existsMock,
}));
vi.mock("@/lib/storage", () => ({ removeObject: removeObjMock }));

import { PUT } from "./route";

const ctx = (id = "p1") => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) =>
  new Request("http://localhost/api/software/packages/p1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const steps = [{ kind: "script", name: "s", script: "x" }];

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ email: "me@opus.local" });
  hasPermMock.mockReturnValue(true);
  existsMock.mockResolvedValue(false);
  updateMock.mockResolvedValue({ outcome: "ok", orphanKeys: [] });
});

describe("PUT /api/software/packages/[id]", () => {
  it("403 without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect((await PUT(req({ name: "A", version: "1", steps }), ctx())).status).toBe(403);
  });

  it("400 with no steps", async () => {
    expect((await PUT(req({ name: "A", version: "1", steps: [] }), ctx())).status).toBe(400);
  });

  it("409 when another package already has that name+version", async () => {
    existsMock.mockResolvedValue(true);
    const res = await PUT(req({ name: "A", version: "1", steps }), ctx());
    expect(res.status).toBe(409);
    // The dup check excludes this package's own id.
    expect(existsMock).toHaveBeenCalledWith("A", "1", "p1");
  });

  it("404 when the package no longer exists", async () => {
    updateMock.mockResolvedValue({ outcome: "notfound" });
    expect((await PUT(req({ name: "A", version: "1", steps }), ctx())).status).toBe(404);
  });

  it("updates and reclaims orphaned files", async () => {
    updateMock.mockResolvedValue({ outcome: "ok", orphanKeys: ["k1", "k2"] });
    const res = await PUT(req({ name: "A", version: "1", steps }), ctx());
    expect(res.status).toBe(200);
    expect(removeObjMock).toHaveBeenCalledWith("k1");
    expect(removeObjMock).toHaveBeenCalledWith("k2");
  });
});
