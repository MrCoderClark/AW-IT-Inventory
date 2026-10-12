import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the uploaded-installer catalog (spec 23). The DB client is mocked;
 * the logic under test is create, the active-only list, and remove's delete-vs-
 * archive branch (hard-delete when unused, soft-archive when history references it).
 *   AC-1   createSoftwarePackage
 *   AC-10  removeSoftwarePackage soft-guard (archive while in use)
 */

const H = vi.hoisted(() => {
  const state: {
    selects: unknown[][];
    insertReturns: unknown[][];
    updateSets: Record<string, unknown>[];
    deleteCalls: number;
  } = { selects: [], insertReturns: [], updateSets: [], deleteCalls: 0 };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "where", "orderBy", "limit"]) b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selects.shift() ?? []).then(res, rej);
    return b;
  };
  const selectMock = vi.fn(() => makeSelect());

  const insertMock = vi.fn(() => ({
    values: () => ({
      returning: () => Promise.resolve(state.insertReturns.shift() ?? []),
    }),
  }));

  const updateMock = vi.fn(() => ({
    set: (vals: Record<string, unknown>) => {
      state.updateSets.push(vals);
      return { where: () => Promise.resolve() };
    },
  }));

  const deleteMock = vi.fn(() => ({
    where: () => {
      state.deleteCalls++;
      return Promise.resolve();
    },
  }));

  return { state, selectMock, insertMock, updateMock, deleteMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    insert: H.insertMock,
    update: H.updateMock,
    delete: H.deleteMock,
  },
}));

import {
  createSoftwarePackage,
  listSoftwarePackages,
  removeSoftwarePackage,
  updateSoftwarePackage,
} from "./software-packages";

const PID = "0959927f-1046-4582-9a70-60a4175f206b";
const STEP = {
  id: "s1",
  kind: "install" as const,
  name: "App",
  installerType: "msi" as const,
  fileName: "app.msi",
  silentArgs: "",
  sha256: "abc",
  storageKey: "software/x/y.msi",
  fileSize: 123,
};
const PKG = {
  id: PID,
  name: "App",
  version: "1.0",
  publisher: null,
  steps: [STEP],
  uploadedBy: "me",
  archivedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  H.state.selects = [];
  H.state.insertReturns = [];
  H.state.updateSets = [];
  H.state.deleteCalls = 0;
});

describe("createSoftwarePackage (AC-1)", () => {
  it("inserts and returns the new id", async () => {
    H.state.insertReturns = [[{ id: PID }]];
    const id = await createSoftwarePackage({
      name: "App",
      version: "1.0",
      steps: [STEP],
      uploadedBy: "me",
    });
    expect(id).toBe(PID);
  });
});

describe("listSoftwarePackages", () => {
  it("returns the active packages", async () => {
    H.state.selects = [[PKG]];
    expect(await listSoftwarePackages()).toEqual([PKG]);
  });
});

describe("removeSoftwarePackage — soft-guard (AC-10)", () => {
  it("is notfound for an unknown id", async () => {
    H.state.selects = [[]]; // getSoftwarePackage → null
    expect(await removeSoftwarePackage(PID)).toEqual({ outcome: "notfound" });
  });

  it("archives when deployment history references it", async () => {
    H.state.selects = [[PKG], [{ id: "d1" }]]; // getPkg, then used check finds one
    expect(await removeSoftwarePackage(PID)).toEqual({
      outcome: "archived",
      storageKeys: [STEP.storageKey],
    });
    expect(H.state.updateSets[0]).toMatchObject({ archivedAt: expect.any(Date) });
    expect(H.state.deleteCalls).toBe(0);
  });

  it("hard-deletes when nothing references it", async () => {
    H.state.selects = [[PKG], []]; // getPkg, then no history
    expect(await removeSoftwarePackage(PID)).toEqual({
      outcome: "deleted",
      storageKeys: [STEP.storageKey],
    });
    expect(H.state.deleteCalls).toBe(1);
  });

  it("returns notfound for a malformed id without querying", async () => {
    expect(await removeSoftwarePackage("nope")).toEqual({ outcome: "notfound" });
    expect(H.selectMock).not.toHaveBeenCalled();
  });
});

describe("updateSoftwarePackage — orphan cleanup", () => {
  it("reports the keys dropped by the edit", async () => {
    // Existing package has the installer + one companion; the edit keeps only the
    // installer, so the companion's key is orphaned.
    const withCompanion = {
      ...PKG,
      steps: [{ ...STEP, companions: [{ storageKey: "companion-key", sha256: "z", fileName: "a.iss", fileSize: 1 }] }],
    };
    H.state.selects = [[withCompanion]]; // getSoftwarePackage
    const res = await updateSoftwarePackage(PID, {
      name: "App",
      version: "1.1",
      steps: [STEP], // installer kept (same storageKey), companion gone
    });
    expect(res).toEqual({ outcome: "ok", orphanKeys: ["companion-key"] });
    expect(H.state.updateSets[0]).toMatchObject({ name: "App", version: "1.1" });
  });

  it("is notfound for an unknown package", async () => {
    H.state.selects = [[]];
    expect(await updateSoftwarePackage(PID, { name: "A", version: "1", steps: [STEP] })).toEqual({
      outcome: "notfound",
    });
  });
});
