// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/software/packages/files (spec 23, AC-1) — store one installer
 * file for an install step. Auth + storage are mocked. Locks the `software:deploy`
 * gate, the type guard, and the returned step file metadata.
 */
const { getUserMock, hasPermMock, putMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/lib/storage", () => ({
  isStorageConfigured: () => true,
  MAX_INSTALLER_BYTES: 300 * 1024 * 1024,
  installerTypeFromName: (name: string) => {
    const ext = name.toLowerCase().split(".").pop();
    return ext === "msi" ? "msi" : ext === "exe" ? "exe" : null;
  },
  newInstallerKey: () => "software/x/y.msi",
  putObject: putMock,
  sha256Hex: () => "deadbeef",
}));

import { POST } from "./route";

const req = (fileName: string | null) => {
  const fd = new FormData();
  if (fileName)
    fd.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], fileName, { type: "application/octet-stream" }),
    );
  return new Request("http://localhost/api/software/packages/files", {
    method: "POST",
    body: fd,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ email: "me@opus.local" });
  hasPermMock.mockReturnValue(true);
});

describe("POST /api/software/packages/files", () => {
  it("403 without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect((await POST(req("app.msi"))).status).toBe(403);
  });

  it("415 for a non-installer file", async () => {
    expect((await POST(req("notes.txt"))).status).toBe(415);
  });

  it("stores the bytes and returns the step file metadata", async () => {
    const res = await POST(req("setup.exe"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      file: {
        storageKey: "software/x/y.msi",
        sha256: "deadbeef",
        fileSize: 3,
        fileName: "setup.exe",
        installerType: "exe",
      },
    });
    expect(putMock).toHaveBeenCalled();
  });
});
