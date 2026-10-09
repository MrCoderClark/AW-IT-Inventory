import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the software-icon storage helpers (spec 22). The DB client,
 * object storage and sharp are the boundaries and are mocked; the logic under test
 * is the uuid guard, the processed-PNG store path, and the remove/serve lookups.
 */

const H = vi.hoisted(() => {
  const state: {
    selectRows: unknown[]; // rows the (single) select resolves to
    bad: boolean; // make processIcon throw
  } = { selectRows: [], bad: false };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "where", "limit"]) b[m] = self;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(state.selectRows).then(res);
    return b;
  };
  const selectMock = vi.fn(() => makeSelect());
  const setMock = vi.fn(() => ({ where: () => Promise.resolve() }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const putImage = vi.fn(async () => {});
  const removeImage = vi.fn(async () => {});
  const getImageBytes = vi.fn(async () => ({ bytes: new Uint8Array([1]), contentType: "image/png" }));
  const processIcon = vi.fn(async () => {
    if (state.bad) throw new Error("bad image");
    return Buffer.from([9, 9, 9]);
  });

  return { state, selectMock, updateMock, setMock, putImage, removeImage, getImageBytes, processIcon };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: { select: H.selectMock, update: H.updateMock },
}));
vi.mock("@/lib/storage", () => ({
  putImage: H.putImage,
  removeImage: H.removeImage,
  getImageBytes: H.getImageBytes,
}));
vi.mock("@/lib/image", () => ({ processIcon: H.processIcon }));

import {
  setSoftwareIcon,
  removeSoftwareIcon,
  getSoftwareIconObject,
} from "./software-icons";

const UUID = "0959927f-1046-4582-9a70-60a4175f206b";

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selectRows = [];
  H.state.bad = false;
});

describe("setSoftwareIcon", () => {
  it("rejects a malformed id without touching storage", async () => {
    expect(await setSoftwareIcon("nope", Buffer.from([1]))).toBe("not-found");
    expect(H.selectMock).not.toHaveBeenCalled();
    expect(H.putImage).not.toHaveBeenCalled();
  });

  it("returns not-found when the title does not exist", async () => {
    H.state.selectRows = [];
    expect(await setSoftwareIcon(UUID, Buffer.from([1]))).toBe("not-found");
    expect(H.putImage).not.toHaveBeenCalled();
  });

  it("stores the processed PNG and stamps the row on success", async () => {
    H.state.selectRows = [{ id: UUID }];
    expect(await setSoftwareIcon(UUID, Buffer.from([1]))).toBe("ok");
    expect(H.processIcon).toHaveBeenCalledOnce();
    expect(H.putImage).toHaveBeenCalledWith(
      `software-icons/${UUID}.png`,
      expect.any(Buffer),
      "image/png",
    );
    expect(H.updateMock).toHaveBeenCalled();
  });

  it("returns bad-image when the upload cannot be processed", async () => {
    H.state.selectRows = [{ id: UUID }];
    H.state.bad = true;
    expect(await setSoftwareIcon(UUID, Buffer.from([1]))).toBe("bad-image");
    expect(H.putImage).not.toHaveBeenCalled();
  });
});

describe("removeSoftwareIcon", () => {
  it("deletes the object when a custom icon exists", async () => {
    H.state.selectRows = [{ iconKey: `software-icons/${UUID}.png` }];
    expect(await removeSoftwareIcon(UUID)).toBe(true);
    expect(H.removeImage).toHaveBeenCalledWith(`software-icons/${UUID}.png`);
    expect(H.updateMock).toHaveBeenCalled();
  });

  it("clears the row without a storage call when there is no custom icon", async () => {
    H.state.selectRows = [{ iconKey: null }];
    expect(await removeSoftwareIcon(UUID)).toBe(true);
    expect(H.removeImage).not.toHaveBeenCalled();
  });

  it("returns false for an unknown title", async () => {
    H.state.selectRows = [];
    expect(await removeSoftwareIcon(UUID)).toBe(false);
  });
});

describe("getSoftwareIconObject", () => {
  it("returns null when the title has no custom icon", async () => {
    H.state.selectRows = [{ iconKey: null }];
    expect(await getSoftwareIconObject(UUID)).toBeNull();
    expect(H.getImageBytes).not.toHaveBeenCalled();
  });

  it("reads the stored bytes when a custom icon exists", async () => {
    H.state.selectRows = [{ iconKey: `software-icons/${UUID}.png` }];
    const obj = await getSoftwareIconObject(UUID);
    expect(obj).toEqual({ bytes: new Uint8Array([1]), contentType: "image/png" });
  });
});
