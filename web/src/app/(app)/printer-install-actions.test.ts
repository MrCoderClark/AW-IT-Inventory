import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the remote printer-install Server Actions (spec 20). The db layer,
 * the catalog reader, the auth session, and Next's cache are mocked; the
 * `printer:install` gate and the input + target + package validation run for
 * real. Locks in AC-9 (gate), AC-2 (no IP), AC-10 (catalog), and the enqueue.
 */

const {
  enqueueMock,
  enqueueListMock,
  enqueueRemoveMock,
  cancelMock,
  resolveTargetMock,
  getPackageMock,
  snapshotMock,
  getCurrentUserMock,
  hasPermissionMock,
  revalidateMock,
} = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  enqueueListMock: vi.fn(),
  enqueueRemoveMock: vi.fn(),
  cancelMock: vi.fn(),
  resolveTargetMock: vi.fn(),
  getPackageMock: vi.fn(),
  snapshotMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("@/db/printer-install", () => ({
  enqueueInstall: enqueueMock,
  enqueueList: enqueueListMock,
  enqueueRemove: enqueueRemoveMock,
  cancelPendingInstall: cancelMock,
  resolveInstallTarget: resolveTargetMock,
}));
vi.mock("@/lib/printer-packages", () => ({
  getPrinterPackage: getPackageMock,
  snapshotOf: snapshotMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
  hasPermission: hasPermissionMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { installPrinterAction } from "./printer-install-actions";

function grant(allowed: boolean) {
  getCurrentUserMock.mockResolvedValue(
    allowed ? { email: "a@x.co" } : null,
  );
  hasPermissionMock.mockReturnValue(allowed);
}

const VALID = {
  packageId: "canon-ir1750",
  printerName: "Finance Canon",
  connectionType: "tcpip",
  host: "192.168.70.202",
  port: "9100",
  sharePath: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveTargetMock.mockResolvedValue({ assetId: "uuid-1", ip: "192.168.72.10" });
  getPackageMock.mockResolvedValue({
    id: "canon-ir1750",
    driverName: "Canon iR1750",
    infPath: "driver/x.inf",
    arch: "x64",
    sha256: "abc",
  });
  snapshotMock.mockReturnValue({
    driverName: "Canon iR1750",
    infPath: "driver/x.inf",
    arch: "x64",
    sha256: "abc",
  });
  enqueueMock.mockResolvedValue("job-1");
});

describe("installPrinterAction — gate (AC-9)", () => {
  it("refuses a caller without printer:install and enqueues nothing", async () => {
    grant(false);
    const res = await installPrinterAction("OPUS-COMP-1", VALID);
    expect(res.ok).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("installPrinterAction — validation", () => {
  beforeEach(() => grant(true));

  it("rejects a missing TCP/IP host", async () => {
    const res = await installPrinterAction("OPUS-COMP-1", { ...VALID, host: "" });
    expect(res.ok).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("refuses a computer with no IP (AC-2)", async () => {
    resolveTargetMock.mockResolvedValue(null);
    const res = await installPrinterAction("OPUS-COMP-1", VALID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no IP/i);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("refuses a package not in the catalog (AC-10)", async () => {
    getPackageMock.mockResolvedValue(null);
    const res = await installPrinterAction("OPUS-COMP-1", VALID);
    expect(res.ok).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("installPrinterAction — enqueue", () => {
  beforeEach(() => grant(true));

  it("enqueues a frozen snapshot + resolved connection and revalidates", async () => {
    const res = await installPrinterAction("OPUS-COMP-1", VALID, "printer-asset-9");
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "uuid-1",
        targetIp: "192.168.72.10",
        packageId: "canon-ir1750",
        printerName: "Finance Canon",
        connection: { type: "tcpip", host: "192.168.70.202", port: 9100, replace: true },
        sourcePrinterAssetId: "printer-asset-9",
        requestedBy: "a@x.co",
      }),
    );
    expect(revalidateMock).toHaveBeenCalledWith("/assets/OPUS-COMP-1");
  });
});
