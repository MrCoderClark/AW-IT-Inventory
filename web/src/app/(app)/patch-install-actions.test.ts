// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  getUserMock,
  hasPermMock,
  resolveTargetMock,
  buildSelectionMock,
  enqueuePatchMock,
  enqueueRebootMock,
  enqueueFleetMock,
  resolveGroupMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  resolveTargetMock: vi.fn(),
  buildSelectionMock: vi.fn(),
  enqueuePatchMock: vi.fn(),
  enqueueRebootMock: vi.fn(),
  enqueueFleetMock: vi.fn(),
  resolveGroupMock: vi.fn(),
}));

vi.mock("@/db/reboot", () => ({
  enqueueRebootJob: enqueueRebootMock,
}));
vi.mock("@/db/patch-install", () => ({
  buildPatchSelection: buildSelectionMock,
  enqueuePatchInstall: enqueuePatchMock,
  enqueueFleetOsPatchInstalls: (...args: unknown[]) =>
    enqueueFleetMock(...args),
  cancelPatchInstall: vi.fn(),
  getPatchInstallJob: vi.fn(),
  resolveDeployTarget: resolveTargetMock,
  FLEET_OS_INSTALL_TAG_CAP: 100,
}));
vi.mock("@/db/missing-update-checks", () => ({
  enqueueMissingUpdateCheck: vi.fn(),
  resolveDeployTarget: vi.fn(),
  listMissingUpdateChecksForAssetTag: vi.fn(),
}));
vi.mock("@/db/patches", () => ({
  getComputerPatches: vi.fn(),
}));
vi.mock("@/db/script-targets", () => ({
  resolveDeviceGroup: (...args: unknown[]) => resolveGroupMock(...args),
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  requestFleetOsPatchInstall,
  requestPatchInstall,
} from "./patch-install-actions";

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

describe("requestFleetOsPatchInstall with deviceGroupId", () => {
  beforeEach(() => {
    enqueueFleetMock.mockResolvedValue({
      enqueued: ["jid-1"],
      skipped: [],
    });
  });

  it("resolves the group then enqueues by tags", async () => {
    resolveGroupMock.mockResolvedValue({
      resolved: [
        { assetId: "a1", tag: "PC-1", ip: "10.0.0.1" },
        { assetId: "a2", tag: "PC-2", ip: "10.0.0.2" },
      ],
      skippedNoIp: 1,
    });
    const res = await requestFleetOsPatchInstall({
      deviceGroupId: "g1",
    });
    expect(resolveGroupMock).toHaveBeenCalledWith("g1");
    expect(enqueueFleetMock).toHaveBeenCalledWith({
      tags: ["PC-1", "PC-2"],
      requestedBy: "me@opus.local",
    });
    expect(res).toEqual({ ok: true, enqueued: ["jid-1"], skipped: [] });
  });

  it("rejects an empty group resolve", async () => {
    resolveGroupMock.mockResolvedValue({
      resolved: [],
      skippedNoIp: 2,
    });
    const res = await requestFleetOsPatchInstall({ deviceGroupId: "g1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/IP address/i);
    expect(enqueueFleetMock).not.toHaveBeenCalled();
  });
});
