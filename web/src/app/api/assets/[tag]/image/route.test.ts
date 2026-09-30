// @vitest-environment node
// This is a server route: run it in node so File/FormData/Request are the same
// undici globals the route uses (jsdom's File differs, breaking `instanceof File`).
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for /api/assets/[tag]/image (spec 17.02). Auth, the DB pointer module,
 * and the object store are mocked, so the test exercises the route's own logic:
 * the asset:write gate (both ways), type/size validation, streaming a stored
 * image, and object cleanup on replace/delete. Locks in AC-2.1, AC-2.3, AC-2.4,
 * AC-2.5.
 */

type User = { email: string; permissions: string[] };

const {
  getUserMock,
  getRefMock,
  setKeyMock,
  clearKeyMock,
  putMock,
  getBytesMock,
  removeMock,
  storageConfiguredMock,
  newKeyMock,
  revalidateMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  getRefMock: vi.fn(),
  setKeyMock: vi.fn(),
  clearKeyMock: vi.fn(),
  putMock: vi.fn(),
  getBytesMock: vi.fn(),
  removeMock: vi.fn(),
  storageConfiguredMock: vi.fn(),
  newKeyMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: (u: User | null, p: string) => !!u && u.permissions.includes(p),
}));
vi.mock("@/db/asset-images", () => ({
  getAssetImageRef: getRefMock,
  setAssetImageKey: setKeyMock,
  clearAssetImageKey: clearKeyMock,
}));
vi.mock("@/lib/storage", () => ({
  isStorageConfigured: storageConfiguredMock,
  isAllowedImageType: (t: string) =>
    ["image/png", "image/jpeg", "image/webp"].includes(t),
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  newImageKey: newKeyMock,
  putImage: putMock,
  getImageBytes: getBytesMock,
  removeImage: removeMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { GET, POST, DELETE } from "./route";

const reader: User = { email: "r@opus.local", permissions: ["asset:read"] };
const writer: User = {
  email: "w@opus.local",
  permissions: ["asset:read", "asset:write"],
};

const ctx = (tag = "OPUS-PRNT-1") => ({ params: Promise.resolve({ tag }) });
const plainReq = (method: string) =>
  new Request("http://localhost/api/assets/OPUS-PRNT-1/image", { method });
function uploadReq(file?: File) {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new Request("http://localhost/api/assets/OPUS-PRNT-1/image", {
    method: "POST",
    body: fd,
  });
}
const png = (bytes = 16) =>
  new File([new Uint8Array(bytes)], "x.png", { type: "image/png" });

beforeEach(() => {
  vi.clearAllMocks();
  storageConfiguredMock.mockReturnValue(true);
  newKeyMock.mockReturnValue("assets/id1/newkey.png");
});

describe("GET image — view gate + stream (AC-2.5, AC-2.2)", () => {
  it("401 when not signed in", async () => {
    getUserMock.mockResolvedValue(null);
    expect((await GET(plainReq("GET"), ctx())).status).toBe(401);
  });

  it("403 when the user lacks asset:read", async () => {
    getUserMock.mockResolvedValue({ email: "x", permissions: [] });
    expect((await GET(plainReq("GET"), ctx())).status).toBe(403);
  });

  it("404 when the asset has no image", async () => {
    getUserMock.mockResolvedValue(reader);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: null });
    const res = await GET(plainReq("GET"), ctx());
    expect(res.status).toBe(404);
    expect(getBytesMock).not.toHaveBeenCalled();
  });

  it("streams the stored bytes with its content type and a private cache", async () => {
    getUserMock.mockResolvedValue(reader);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: "k1" });
    getBytesMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });
    const res = await GET(plainReq("GET"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("private");
    expect((await res.arrayBuffer()).byteLength).toBe(3);
  });
});

describe("POST image — write gate + validation (AC-2.1, AC-2.3)", () => {
  it("403 when the user lacks asset:write", async () => {
    getUserMock.mockResolvedValue(reader);
    const res = await POST(uploadReq(png()), ctx());
    expect(res.status).toBe(403);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("404 when the asset does not exist", async () => {
    getUserMock.mockResolvedValue(writer);
    getRefMock.mockResolvedValue(null);
    expect((await POST(uploadReq(png()), ctx())).status).toBe(404);
  });

  it("400 when no file is attached", async () => {
    getUserMock.mockResolvedValue(writer);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: null });
    expect((await POST(uploadReq(), ctx())).status).toBe(400);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("415 for a non-image file", async () => {
    getUserMock.mockResolvedValue(writer);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: null });
    const txt = new File(["hello"], "note.txt", { type: "text/plain" });
    const res = await POST(uploadReq(txt), ctx());
    expect(res.status).toBe(415);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("413 for a file over 5 MB", async () => {
    getUserMock.mockResolvedValue(writer);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: null });
    const res = await POST(uploadReq(png(6 * 1024 * 1024)), ctx());
    expect(res.status).toBe(413);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe("POST image — store + replace cleanup (AC-2.1, AC-2.4)", () => {
  it("stores the object and sets the asset's imageKey", async () => {
    getUserMock.mockResolvedValue(writer);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: null });
    const res = await POST(uploadReq(png()), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      imageKey: "assets/id1/newkey.png",
    });
    expect(putMock).toHaveBeenCalledOnce();
    expect(setKeyMock).toHaveBeenCalledWith("id1", "assets/id1/newkey.png");
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("deletes the superseded object when replacing an existing image", async () => {
    getUserMock.mockResolvedValue(writer);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: "old-key" });
    const res = await POST(uploadReq(png()), ctx());
    expect(res.status).toBe(200);
    expect(setKeyMock).toHaveBeenCalledWith("id1", "assets/id1/newkey.png");
    expect(removeMock).toHaveBeenCalledWith("old-key");
  });
});

describe("DELETE image — write gate + cleanup (AC-2.4)", () => {
  it("403 when the user lacks asset:write", async () => {
    getUserMock.mockResolvedValue(reader);
    const res = await DELETE(plainReq("DELETE"), ctx());
    expect(res.status).toBe(403);
    expect(clearKeyMock).not.toHaveBeenCalled();
  });

  it("clears the key and removes the object when one exists", async () => {
    getUserMock.mockResolvedValue(writer);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: "k1" });
    const res = await DELETE(plainReq("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(clearKeyMock).toHaveBeenCalledWith("id1");
    expect(removeMock).toHaveBeenCalledWith("k1");
  });

  it("is a no-op when the asset has no image", async () => {
    getUserMock.mockResolvedValue(writer);
    getRefMock.mockResolvedValue({ id: "id1", imageKey: null });
    const res = await DELETE(plainReq("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(clearKeyMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });
});
