// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for POST /api/software/packages (spec 23, AC-1/AC-7) — create a package
 * (header + ordered steps). Auth and the catalog DB are mocked. Locks the
 * `software:deploy` gate, step validation (empty steps, EXE needs args, install
 * step needs an uploaded file), the dup guard, and the happy-path create.
 */
const { getUserMock, hasPermMock, existsMock, createMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  existsMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/db/software-packages", () => ({
  createSoftwarePackage: createMock,
  softwarePackageExists: existsMock,
}));

import { POST } from "./route";

const req = (body: unknown) =>
  new Request("http://localhost/api/software/packages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const scriptStep = { kind: "script", name: "Enable NetFx3", script: "Enable-..." };
const installStep = {
  kind: "install",
  name: "App",
  installerType: "msi",
  fileName: "app.msi",
  silentArgs: "",
  sha256: "abc",
  storageKey: "software/x/y.msi",
  fileSize: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ email: "me@opus.local" });
  hasPermMock.mockReturnValue(true);
  existsMock.mockResolvedValue(false);
  createMock.mockResolvedValue("pkg-1");
});

describe("POST /api/software/packages", () => {
  it("403 without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect(
      (await POST(req({ name: "A", version: "1", steps: [scriptStep] }))).status,
    ).toBe(403);
  });

  it("400 when there are no steps", async () => {
    expect((await POST(req({ name: "A", version: "1", steps: [] }))).status).toBe(400);
  });

  it("400 when version is missing", async () => {
    expect((await POST(req({ name: "A", steps: [scriptStep] }))).status).toBe(400);
  });

  it("400 for an EXE install step without silent args", async () => {
    const res = await POST(
      req({
        name: "A",
        version: "1",
        steps: [{ ...installStep, installerType: "exe", silentArgs: "" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 for an install step missing its uploaded file", async () => {
    const res = await POST(
      req({ name: "A", version: "1", steps: [{ ...installStep, storageKey: "" }] }),
    );
    expect(res.status).toBe(400);
  });

  it("409 when a package name+version already exists", async () => {
    existsMock.mockResolvedValue(true);
    expect(
      (await POST(req({ name: "A", version: "1", steps: [scriptStep] }))).status,
    ).toBe(409);
  });

  it("creates a package with ordered steps and assigns step ids", async () => {
    const res = await POST(
      req({ name: "ePad II", version: "12.4", steps: [scriptStep, installStep] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "pkg-1" });
    const arg = createMock.mock.calls[0][0];
    expect(arg.name).toBe("ePad II");
    expect(arg.steps).toHaveLength(2);
    expect(arg.steps[0].kind).toBe("script");
    expect(arg.steps[1].kind).toBe("install");
    // Ids are assigned server-side (stable in the frozen snapshot).
    expect(typeof arg.steps[0].id).toBe("string");
    expect(arg.uploadedBy).toBe("me@opus.local");
  });
});
