// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  getUserMock,
  hasPermMock,
  resolveTargetMock,
  buildSelectionMock,
  enqueuePatchMock,
  enqueueRebootMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  resolveTargetMock: vi.fn(),
  buildSelectionMock: vi.fn(),
  enqueuePatchMock: vi.fn(),
  enqueueRebootMock: vi.fn(),
}));

vi.mock("@/db/reboot", () => ({
  enqueueRebootJob: enqueueRebootMock,
}));
vi.mock("@/db/patch-install", () => ({
  buildPatchSelection: buildSelectionMock,
  enqueuePatchInstall: enqueuePatchMock,
  enqueueFleetOsPatchInstalls: vi.fn(),
  cancelPatchInstall: vi.fn(),
  getPatchInstallJob: vi.fn(),
  resolveDeployTarget: resolveTargetMock,
  FLEET_OS_INSTALL_TAG_CAP: 100,
}));
vi.mock("@/db/missing-update-checks", () => ({
  enqueueMissingUpdateCheck: vi.fn(),
  resolveDeployTarget: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requestPatchInstall } from "./patch-install-actions";

const SEL = {
  os: [{ kbId: "KB1", title: "Security Update" }],
  apps: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ email: "me@opus.local" });
  hasPermMock.mockReturnValue(true);
  resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
  buildSelectionMock.mockResolvedValue({ ok: true, selection: SEL });
  enqueuePatchMock.mockResolvedValue({ ok: true, id: "install-1" });
});

describe("requestPatchInstall with rebootAtIso", () => {
  it("enqueues a linked reboot after install", async () => {
    enqueueRebootMock.mockResolvedValue({ ok: true, id: "reboot-1" });
    const res = await requestPatchInstall({
      assetTag: "PC1",
      osKbIds: ["KB1"],
      packageIds: [],
      rebootAtIso: "2026-12-01T12:00:00.000Z",
    });
    expect(res).toEqual({ ok: true, id: "install-1" });
    expect(enqueueRebootMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "a1",
        targetIp: "10.0.0.1",
        sourcePatchInstallJobId: "install-1",
        requestedBy: "me@opus.local",
      }),
    );
  });

  it("keeps install ok when linked reboot is already in flight", async () => {
    enqueueRebootMock.mockResolvedValue({ ok: false, reason: "already-inflight" });
    const res = await requestPatchInstall({
      assetTag: "PC1",
      osKbIds: ["KB1"],
      packageIds: [],
      rebootAtIso: "2026-12-01T12:00:00.000Z",
    });
    expect(res).toMatchObject({ ok: true, id: "install-1", rebootWarning: expect.any(String) });
  });
});
