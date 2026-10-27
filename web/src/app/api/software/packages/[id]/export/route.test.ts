// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * GET /api/software/packages/[id]/export — break-glass `.ps1` mint (spec 23 polish).
 */
const { getUserMock, hasPermMock, getPkgMock, mintMock, buildMock } = vi.hoisted(
  () => ({
    getUserMock: vi.fn(),
    hasPermMock: vi.fn(),
    getPkgMock: vi.fn(),
    mintMock: vi.fn(),
    buildMock: vi.fn(),
  }),
);

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/db/software-packages", () => ({
  getSoftwarePackage: getPkgMock,
}));
vi.mock("@/lib/software-export-sign", () => ({
  exportExpiryUnix: () => 9999999999,
  mintExportFileSig: mintMock,
}));
vi.mock("@/lib/software-export-script", () => ({
  buildExportPs1: buildMock,
}));
vi.mock("@/lib/ai/config", () => ({
  isAiConfigured: () => false,
  loadAiConfig: () => ({}),
}));
vi.mock("@/lib/ai/providers", () => ({ getAiProvider: vi.fn() }));

import { GET } from "./route";

const PKG_ID = "11111111-1111-4111-8111-111111111111";

const samplePkg = {
  id: PKG_ID,
  name: "ePad",
  version: "1.0",
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
const req = (query = "") =>
  new Request(
    `http://localhost:3000/api/software/packages/${PKG_ID}/export${query}`,
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SOFTWARE_EXPORT_SIGNING_SECRET = "test-secret";
  getUserMock.mockResolvedValue({ email: "admin@opus.local" });
  hasPermMock.mockReturnValue(true);
  getPkgMock.mockResolvedValue(samplePkg);
  mintMock.mockReturnValue("abc".repeat(21).slice(0, 64));
  buildMock.mockReturnValue("#Requires -RunAsAdministrator\nWrite-Host ok");
});

describe("GET /api/software/packages/[id]/export", () => {
  it("401 when not signed in", async () => {
    getUserMock.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(401);
  });

  it("403 without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect((await GET(req(), ctx())).status).toBe(403);
  });

  it("404 when the package is missing", async () => {
    getPkgMock.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(404);
  });

  it("500 JSON when signing secret is missing at mint time", async () => {
    mintMock.mockImplementation(() => {
      throw new Error(
        "SOFTWARE_EXPORT_SIGNING_SECRET is required for package export file URLs",
      );
    });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("SOFTWARE_EXPORT_SIGNING_SECRET"),
    });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("returns a text/plain attachment with minted file URLs", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Content-Disposition")).toContain(".ps1");
    expect(buildMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "ePad",
        version: "1.0",
        files: [
          expect.objectContaining({
            fileName: "setup.exe",
            url: expect.stringContaining("export-file"),
          }),
        ],
      }),
    );
    expect(mintMock).toHaveBeenCalledWith(
      PKG_ID,
      "setup.exe",
      "software/setup.exe",
      9999999999,
    );
    await expect(res.text()).resolves.toContain("RunAsAdministrator");
  });

  it("dedupes the same EXE used on uninstall + install steps", async () => {
    const hash = "c".repeat(64);
    getPkgMock.mockResolvedValue({
      ...samplePkg,
      steps: [
        {
          id: "u1",
          kind: "install" as const,
          name: "Uninstall",
          installerType: "exe" as const,
          fileName: "setup.exe",
          silentArgs: '/s /f1"%DIR%\\uninstall.iss"',
          sha256: hash,
          storageKey: "software/upload-a/setup.exe",
          fileSize: 10,
          continueOnError: true,
          companions: [
            {
              fileName: "uninstall.iss",
              storageKey: "software/upload-a/uninstall.iss",
              sha256: "d".repeat(64),
              fileSize: 1,
            },
          ],
        },
        {
          id: "i1",
          kind: "install" as const,
          name: "Install",
          installerType: "exe" as const,
          fileName: "setup.exe",
          silentArgs: '/s /f1"%DIR%\\install.iss"',
          sha256: hash,
          storageKey: "software/upload-b/setup.exe",
          fileSize: 10,
          companions: [
            {
              fileName: "install.iss",
              storageKey: "software/upload-b/install.iss",
              sha256: "e".repeat(64),
              fileSize: 1,
            },
          ],
        },
      ],
    });

    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const files = buildMock.mock.calls[0][0].files as { fileName: string }[];
    expect(files.map((f) => f.fileName).sort()).toEqual([
      "install.iss",
      "setup.exe",
      "uninstall.iss",
    ]);
    expect(mintMock.mock.calls.filter((c) => c[1] === "setup.exe")).toHaveLength(
      1,
    );
  });

  it("500 when the same fileName maps to different content", async () => {
    getPkgMock.mockResolvedValue({
      ...samplePkg,
      steps: [
        {
          ...samplePkg.steps[0],
          id: "a",
          sha256: "a".repeat(64),
          storageKey: "software/a.exe",
        },
        {
          ...samplePkg.steps[0],
          id: "b",
          name: "Other",
          sha256: "b".repeat(64),
          storageKey: "software/b.exe",
        },
      ],
    });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("duplicate fileName"),
    });
  });
});
