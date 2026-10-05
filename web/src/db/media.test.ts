import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the media-library data layer (spec 18, phase 1). The DB client and
 * the object store are the boundary and are mocked; the logic under test is the
 * three concurrency/cleanup rules the acceptance criteria hinge on:
 *   AC-3  createOrReuseMedia — reuse by hash (no re-store), store+insert when new,
 *         and the dedup race (insert hits 23505 → loser's object removed, winner
 *         returned).
 *   AC-6  deleteMedia — blocked while in use (with the count), removes bytes when
 *         unused, and the delete race (FK 23503 → clean "in use", never a throw).
 */

const H = vi.hoisted(() => {
  const state: {
    selectResults: unknown[][];
    insertReturning: unknown[];
    insertError: (Error & { code?: string; constraint_name?: string }) | null;
    deleteReturning: unknown[];
    deleteError: (Error & { code?: string }) | null;
    updates: Record<string, unknown>[];
  } = {
    selectResults: [],
    insertReturning: [],
    insertError: null,
    deleteReturning: [],
    deleteError: null,
    updates: [],
  };

  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of [
      "from",
      "where",
      "orderBy",
      "limit",
      "offset",
      "groupBy",
      "leftJoin",
    ])
      b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResults.shift() ?? []).then(res, rej);
    return b;
  };
  const selectMock = vi.fn(() => makeBuilder());

  const insertMock = vi.fn(() => ({
    values: () => ({
      returning: () =>
        state.insertError
          ? Promise.reject(state.insertError)
          : Promise.resolve(state.insertReturning),
    }),
  }));

  const deleteMock = vi.fn(() => ({
    where: () => ({
      returning: () =>
        state.deleteError
          ? Promise.reject(state.deleteError)
          : Promise.resolve(state.deleteReturning),
    }),
  }));

  const updateMock = vi.fn(() => ({
    set: (obj: Record<string, unknown>) => {
      state.updates.push(obj);
      return { where: () => Promise.resolve() };
    },
  }));

  const putImageMock = vi.fn(() => Promise.resolve());
  const removeImageMock = vi.fn(() => Promise.resolve());

  return {
    state,
    selectMock,
    insertMock,
    deleteMock,
    updateMock,
    putImageMock,
    removeImageMock,
  };
});

vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    delete: H.deleteMock,
    update: H.updateMock,
  },
}));
vi.mock("@/lib/storage", () => ({
  sha256Hex: () => "deadbeef",
  newMediaObjectKey: (id: string) => `media/${id}/image.png`,
  newMediaThumbKey: (id: string) => `media/${id}/thumb.webp`,
  newMediaCutoutKey: (id: string) => `media/${id}/cutout.png`,
  putImage: H.putImageMock,
  removeImage: H.removeImageMock,
}));
// Phase 2: createOrReuseMedia runs sharp processing before storing. Stub it so the
// data-layer logic (dedup, cleanup) is what's under test, not image encoding.
vi.mock("@/lib/image", () => ({
  processImage: vi.fn(async (bytes: Buffer) => ({
    original: bytes,
    width: 100,
    height: 50,
    thumbnail: Buffer.from("thumb"),
  })),
}));

import {
  completeCutout,
  createOrReuseMedia,
  deleteMedia,
  isMediaDedupRace,
  isMediaInUseViolation,
  listMedia,
  requestCutout,
} from "./media";

const bytes = Buffer.from([1, 2, 3, 4]);
const upload = {
  bytes,
  contentType: "image/png" as const,
  name: "Canon iR",
  createdBy: "w@opus.local",
};

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selectResults = [];
  H.state.insertReturning = [];
  H.state.insertError = null;
  H.state.deleteReturning = [];
  H.state.deleteError = null;
  H.state.updates = [];
});

describe("createOrReuseMedia — dedup (AC-3)", () => {
  it("reuses an existing row by hash without storing anything", async () => {
    const existing = { id: "m-existing", objectKey: "media/m-existing/image.png" };
    H.state.selectResults = [[existing]]; // findBySha → found
    const row = await createOrReuseMedia(upload);
    expect(row).toEqual(existing);
    expect(H.putImageMock).not.toHaveBeenCalled();
    expect(H.insertMock).not.toHaveBeenCalled();
  });

  it("stores the object and inserts a row when the content is new", async () => {
    const created = { id: "m-new" };
    H.state.selectResults = [[]]; // findBySha → not found
    H.state.insertReturning = [created];
    const row = await createOrReuseMedia(upload);
    expect(row).toEqual(created);
    expect(H.putImageMock).toHaveBeenCalledTimes(2); // original + thumbnail
    expect(H.removeImageMock).not.toHaveBeenCalled();
  });

  it("on a lost dedup race: removes its object and returns the winning row", async () => {
    const winner = { id: "m-winner", objectKey: "media/m-winner/image.png" };
    // findBySha (miss), then after the race, findBySha (winner).
    H.state.selectResults = [[], [winner]];
    H.state.insertError = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "media_sha256_uq",
    });
    const row = await createOrReuseMedia(upload);
    expect(row).toEqual(winner);
    expect(H.putImageMock).toHaveBeenCalledTimes(2); // stored loser original + thumb…
    expect(H.removeImageMock).toHaveBeenCalledTimes(2); // …then cleaned both up
  });

  it("rethrows a non-dedup insert error (no object cleanup)", async () => {
    H.state.selectResults = [[]];
    H.state.insertError = Object.assign(new Error("boom"), { code: "23502" });
    await expect(createOrReuseMedia(upload)).rejects.toThrow("boom");
  });
});

describe("deleteMedia — in-use guard + cleanup (AC-6)", () => {
  const row = {
    id: "m1",
    objectKey: "media/m1/image.png",
    thumbnailKey: null,
  };

  it("blocks deletion while assets use it, reporting the count", async () => {
    H.state.selectResults = [[row], [{ n: 3 }]]; // getMedia, usage count
    const res = await deleteMedia("m1");
    expect(res).toEqual({ ok: false, error: "in-use", usedBy: 3 });
    expect(H.deleteMock).not.toHaveBeenCalled();
    expect(H.removeImageMock).not.toHaveBeenCalled();
  });

  it("not-found when the row is gone", async () => {
    H.state.selectResults = [[]]; // getMedia → none
    expect(await deleteMedia("m1")).toEqual({ ok: false, error: "not-found" });
  });

  it("deletes the row and removes its bytes when unused", async () => {
    H.state.selectResults = [[row], [{ n: 0 }]];
    H.state.deleteReturning = [{ id: "m1" }];
    const res = await deleteMedia("m1");
    expect(res).toEqual({ ok: true });
    expect(H.removeImageMock).toHaveBeenCalledWith("media/m1/image.png");
  });

  it("turns a delete-race FK violation (23503) into a clean in-use result", async () => {
    // getMedia, usage=0, (delete throws), recount usage=1
    H.state.selectResults = [[row], [{ n: 0 }], [{ n: 1 }]];
    H.state.deleteError = Object.assign(new Error("fk"), { code: "23503" });
    const res = await deleteMedia("m1");
    expect(res).toEqual({ ok: false, error: "in-use", usedBy: 1 });
  });
});

describe("listMedia — usage counts (AC-5)", () => {
  it("attaches usedBy from the grouped join; flattens the media row", async () => {
    const m1 = { id: "m1", name: "A", createdAt: new Date() };
    const m2 = { id: "m2", name: "B", createdAt: new Date() };
    // One query: join + groupBy returns {media, usedBy} rows.
    H.state.selectResults = [
      [
        { media: m1, usedBy: 2 },
        { media: m2, usedBy: 0 },
      ],
    ];
    const page = await listMedia();
    expect(page.items.map((i) => [i.id, i.usedBy])).toEqual([
      ["m1", 2],
      ["m2", 0],
    ]);
    expect(page.nextOffset).toBeNull();
  });
});

describe("requestCutout — enqueue (AC-9)", () => {
  it("not-found when the media row is gone", async () => {
    H.state.selectResults = [[]]; // getMedia → none
    expect(await requestCutout("m1")).toEqual({ ok: false, error: "not-found" });
    expect(H.state.updates).toHaveLength(0);
  });

  it("busy when a job is already pending/processing", async () => {
    H.state.selectResults = [[{ id: "m1", cutoutStatus: "processing" }]];
    expect(await requestCutout("m1")).toEqual({ ok: false, error: "busy" });
    expect(H.state.updates).toHaveLength(0);
  });

  it("enqueues as pending from a terminal/absent state", async () => {
    H.state.selectResults = [[{ id: "m1", cutoutStatus: "failed" }]];
    expect(await requestCutout("m1")).toEqual({ ok: true, status: "pending" });
    expect(H.state.updates[0]).toMatchObject({ cutoutStatus: "pending" });
  });
});

describe("completeCutout — fenced result (AC-9)", () => {
  it("drops a result from a worker that no longer owns the job", async () => {
    H.state.selectResults = [[{ status: "processing", workerId: "other" }]];
    const res = await completeCutout("m1", "me", { ok: false });
    expect(res).toEqual({ ok: false });
    expect(H.state.updates).toHaveLength(0);
    expect(H.putImageMock).not.toHaveBeenCalled();
  });

  it("stores the PNG and marks done on success", async () => {
    H.state.selectResults = [[{ status: "processing", workerId: "w1" }]];
    const res = await completeCutout("m1", "w1", {
      ok: true,
      cutoutBytes: Buffer.from("png"),
    });
    expect(res).toEqual({ ok: true });
    expect(H.putImageMock).toHaveBeenCalledOnce();
    expect(H.state.updates[0]).toMatchObject({
      cutoutStatus: "done",
      cutoutKey: "media/m1/cutout.png",
    });
  });

  it("marks failed without storing on failure", async () => {
    H.state.selectResults = [[{ status: "processing", workerId: "w1" }]];
    const res = await completeCutout("m1", "w1", { ok: false });
    expect(res).toEqual({ ok: true });
    expect(H.putImageMock).not.toHaveBeenCalled();
    expect(H.state.updates[0]).toMatchObject({ cutoutStatus: "failed" });
  });
});

describe("error classifiers", () => {
  it("isMediaDedupRace matches 23505 on the sha index only", () => {
    expect(
      isMediaDedupRace({ code: "23505", constraint_name: "media_sha256_uq" }),
    ).toBe(true);
    expect(
      isMediaDedupRace({ code: "23505", constraint_name: "other_uq" }),
    ).toBe(false);
    expect(isMediaDedupRace({ code: "23503" })).toBe(false);
    expect(isMediaDedupRace(null)).toBe(false);
  });

  it("isMediaInUseViolation matches 23503", () => {
    expect(isMediaInUseViolation({ code: "23503" })).toBe(true);
    expect(isMediaInUseViolation({ code: "23505" })).toBe(false);
  });
});
