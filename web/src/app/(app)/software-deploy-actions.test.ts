// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the software-deploy server actions (spec 23). Auth, the catalog DB, and
 * storage are mocked. Locks the `software:deploy` gate and the delete→remove-object
 * flow (both the hard-delete and soft-archive branches reclaim the bytes).
 */
const {
  getUserMock,
  hasPermMock,
  removePkgMock,
  getPkgMock,
  removeObjMock,
  resolveTargetMock,
  enqueueMock,
  cancelMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  removePkgMock: vi.fn(),
  getPkgMock: vi.fn(),
  removeObjMock: vi.fn(),
  resolveTargetMock: vi.fn(),
  enqueueMock: vi.fn(),
  cancelMock: vi.fn(),
}));

vi.mock("@/db/software-packages", () => ({
  removeSoftwarePackage: removePkgMock,
  getSoftwarePackage: getPkgMock,
}));
vi.mock("@/db/software-deploy", () => ({
  resolveDeployTarget: resolveTargetMock,
  enqueueDeployment: enqueueMock,
  cancelDeployment: cancelMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/lib/storage", () => ({ removeObject: removeObjMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  cancelDeploymentAction,
  deleteSoftwarePackageAction,
  deploySoftwareAction,
} from "./software-deploy-actions";

const PKG = {
  id: "p1",
  name: "App",
  version: "1.0",
  steps: [{ id: "s1", kind: "install" }],
  archivedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ email: "me@opus.local" });
  hasPermMock.mockReturnValue(true);
});

describe("deleteSoftwarePackageAction", () => {
  it("refuses without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect(await deleteSoftwarePackageAction("p1")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(removePkgMock).not.toHaveBeenCalled();
  });

  it("errors on an unknown package", async () => {
    removePkgMock.mockResolvedValue({ outcome: "notfound" });
    const res = await deleteSoftwarePackageAction("p1");
    expect(res.ok).toBe(false);
    expect(removeObjMock).not.toHaveBeenCalled();
  });

  it("deletes and reclaims every install step's bytes", async () => {
    removePkgMock.mockResolvedValue({
      outcome: "deleted",
      storageKeys: ["k1", "k2"],
    });
    const res = await deleteSoftwarePackageAction("p1");
    expect(res).toEqual({ ok: true, message: "Package deleted." });
    expect(removeObjMock).toHaveBeenCalledWith("k1");
    expect(removeObjMock).toHaveBeenCalledWith("k2");
  });

  it("archives (keeps history) and still reclaims the bytes", async () => {
    removePkgMock.mockResolvedValue({ outcome: "archived", storageKeys: ["k3"] });
    const res = await deleteSoftwarePackageAction("p1");
    expect(res.ok).toBe(true);
    expect(removeObjMock).toHaveBeenCalledWith("k3");
  });
});

describe("deploySoftwareAction", () => {
  beforeEach(() => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "192.168.70.5" });
    getPkgMock.mockResolvedValue(PKG);
    enqueueMock.mockResolvedValue({ ok: true, id: "d1" });
  });

  it("refuses without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect((await deploySoftwareAction("PC-1", "p1")).ok).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("422-style refuse when the asset isn't a Computer with an IP", async () => {
    resolveTargetMock.mockResolvedValue(null);
    expect((await deploySoftwareAction("PRN", "p1")).ok).toBe(false);
  });

  it("refuses an archived/missing package", async () => {
    getPkgMock.mockResolvedValue({ ...PKG, archivedAt: new Date() });
    expect((await deploySoftwareAction("PC-1", "p1")).ok).toBe(false);
  });

  it("enqueues with a frozen snapshot of the package steps", async () => {
    const res = await deploySoftwareAction("PC-1", "p1");
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "a1",
        targetIp: "192.168.70.5",
        packageId: "p1",
        requestedBy: "me@opus.local",
        packageSnapshot: expect.objectContaining({ name: "App", steps: PKG.steps }),
      }),
    );
  });

  it("surfaces an in-flight conflict", async () => {
    enqueueMock.mockResolvedValue({ ok: false, reason: "already-inflight" });
    expect((await deploySoftwareAction("PC-1", "p1")).ok).toBe(false);
  });
});

describe("cancelDeploymentAction", () => {
  it("cancels an in-flight deployment", async () => {
    cancelMock.mockResolvedValue(true);
    expect((await cancelDeploymentAction("d1", "PC-1")).ok).toBe(true);
  });

  it("errors when it can no longer be canceled", async () => {
    cancelMock.mockResolvedValue(false);
    expect((await cancelDeploymentAction("d1")).ok).toBe(false);
  });
});
