// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for GET /api/assets/[tag]/image (spec 18, superseding spec 17.02). The
 * route now resolves the asset to its shared media row and delegates to the shared
 * variant server. Auth, the DB lookup, and the variant server are mocked, so this
 * exercises the route's own logic: the asset:read gate (both ways), the 404 when
 * the asset has no image, and delegation for the right variant (AC-7). Uploading
 * and clearing moved to the media flow and are tested there.
 */

type User = { email: string; permissions: string[] };

const { getUserMock, getAssetMediaMock, serveMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  getAssetMediaMock: vi.fn(),
  serveMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: (u: User | null, p: string) => !!u && u.permissions.includes(p),
}));
vi.mock("@/db/asset-images", () => ({ getAssetMedia: getAssetMediaMock }));
vi.mock("@/lib/media-serve", () => ({
  parseVariant: (raw: string | null) =>
    raw === "thumb" || raw === "cutout" ? raw : "original",
  serveMediaVariant: serveMock,
}));

import { GET } from "./route";

const reader: User = { email: "r@opus.local", permissions: ["asset:read"] };
const ctx = (tag = "OPUS-PRNT-1") => ({ params: Promise.resolve({ tag }) });
const req = (url = "http://localhost/api/assets/OPUS-PRNT-1/image") =>
  new Request(url, { method: "GET" });

beforeEach(() => {
  vi.clearAllMocks();
  serveMock.mockResolvedValue(new Response("bytes", { status: 200 }));
});

describe("GET asset image — view gate + delegation (AC-7)", () => {
  it("401 when not signed in", async () => {
    getUserMock.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(401);
  });

  it("403 when the user lacks asset:read", async () => {
    getUserMock.mockResolvedValue({ email: "x", permissions: [] });
    expect((await GET(req(), ctx())).status).toBe(403);
  });

  it("404 when the asset has no image", async () => {
    getUserMock.mockResolvedValue(reader);
    getAssetMediaMock.mockResolvedValue({ assetId: "a1", media: null });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    expect(serveMock).not.toHaveBeenCalled();
  });

  it("404 when the tag matches no asset", async () => {
    getUserMock.mockResolvedValue(reader);
    getAssetMediaMock.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(404);
  });

  it("delegates to the variant server with the asset's media row", async () => {
    getUserMock.mockResolvedValue(reader);
    const media = { id: "m1", objectKey: "media/m1/image.png" };
    getAssetMediaMock.mockResolvedValue({ assetId: "a1", media });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(serveMock).toHaveBeenCalledWith(media, "original");
  });

  it("passes the requested variant through", async () => {
    getUserMock.mockResolvedValue(reader);
    const media = { id: "m1" };
    getAssetMediaMock.mockResolvedValue({ assetId: "a1", media });
    await GET(req("http://localhost/api/assets/OPUS-PRNT-1/image?variant=thumb"), ctx());
    expect(serveMock).toHaveBeenCalledWith(media, "thumb");
  });

  it("serves the cut-out when the image has preferCutout on (spec 18 ph3)", async () => {
    getUserMock.mockResolvedValue(reader);
    const media = { id: "m1", preferCutout: true, cutoutKey: "media/m1/cutout.png" };
    getAssetMediaMock.mockResolvedValue({ assetId: "a1", media });
    // Even a thumb request is overridden to the cut-out when toggled on.
    await GET(req("http://localhost/api/assets/OPUS-PRNT-1/image?variant=thumb"), ctx());
    expect(serveMock).toHaveBeenCalledWith(media, "cutout");
  });

  it("keeps the original when preferCutout is on but no cut-out exists yet", async () => {
    getUserMock.mockResolvedValue(reader);
    const media = { id: "m1", preferCutout: true, cutoutKey: null };
    getAssetMediaMock.mockResolvedValue({ assetId: "a1", media });
    await GET(req(), ctx());
    expect(serveMock).toHaveBeenCalledWith(media, "original");
  });
});
