// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * GET /api/software/packages/[id]/export-file — signed file stream (no cookie).
 */
const { verifyMock, getPkgMock, getBytesMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  getPkgMock: vi.fn(),
  getBytesMock: vi.fn(),
}));

vi.mock("@/lib/software-export-sign", () => ({
  verifyExportFileSig: verifyMock,
}));
vi.mock("@/db/software-packages", () => ({
  getSoftwarePackage: getPkgMock,
}));
vi.mock("@/lib/storage", () => ({
  getObjectBytes: getBytesMock,
}));

import { GET } from "./route";

const PKG_ID = "22222222-2222-4222-8222-222222222222";

const samplePkg = {
  id: PKG_ID,
  steps: [
    {
      id: "s1",
      kind: "install" as const,
      name: "Install",
      installerType: "exe" as const,
      fileName: "setup.exe",
      silentArgs: "/S",
      sha256: "a".repeat(64),
      storageKey: "software/setup.exe",
      fileSize: 10,
    },
  ],
};

const ctx = () => ({ params: Promise.resolve({ id: PKG_ID }) });

function signedReq(overrides?: {
  fileName?: string;
  storageKey?: string;
  exp?: string;
  sig?: string;
}) {
  const u = new URL(
    `http://localhost/api/software/packages/${PKG_ID}/export-file`,
  );
  u.searchParams.set("fileName", overrides?.fileName ?? "setup.exe");
  u.searchParams.set("storageKey", overrides?.storageKey ?? "software/setup.exe");
  u.searchParams.set("exp", overrides?.exp ?? "9999999999");
  u.searchParams.set("sig", overrides?.sig ?? "b".repeat(64));
  return new Request(u.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockReturnValue(true);
  getPkgMock.mockResolvedValue(samplePkg);
  getBytesMock.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]) });
});

describe("GET /api/software/packages/[id]/export-file", () => {
  it("401 when signed query params are missing", async () => {
    const res = await GET(
      new Request(
        `http://localhost/api/software/packages/${PKG_ID}/export-file`,
      ),
      ctx(),
    );
    expect(res.status).toBe(401);
  });

  it("403 when the signature is invalid or expired", async () => {
    verifyMock.mockReturnValue(false);
    expect((await GET(signedReq(), ctx())).status).toBe(403);
  });

  it("404 when storageKey is not in the package", async () => {
    const res = await GET(
      signedReq({ storageKey: "other/key.exe", fileName: "other.exe" }),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it("quotes Content-Disposition for exotic file names", async () => {
    const exotic = 'weird"name.exe';
    getPkgMock.mockResolvedValue({
      steps: [{ ...samplePkg.steps[0], fileName: exotic }],
    });
    const res = await GET(
      signedReq({ fileName: exotic, storageKey: "software/setup.exe" }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toContain('filename="weird_name.exe"');
    expect(cd).toContain("filename*=UTF-8''");
  });

  it("streams object bytes on a valid signature", async () => {
    const res = await GET(signedReq(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(verifyMock).toHaveBeenCalledWith(
      PKG_ID,
      "setup.exe",
      "software/setup.exe",
      9999999999,
      "b".repeat(64),
    );
  });
});
