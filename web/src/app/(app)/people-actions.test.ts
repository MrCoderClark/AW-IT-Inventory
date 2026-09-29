import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the people server actions (spec 16). The DB modules, the auth
 * session, and Next's cache are mocked; the real zod schema runs. Traces:
 *   AC-10 every mutation is gated on `asset:write`, rechecked server-side
 *   AC-1  create validates and reports success
 *   AC-3  duplicate email/employee id map to clear messages
 *   AC-5/AC-6 assign resolves the tag then routes through the engine; return
 *         no-ops when nothing is assigned; an archived assignee is refused
 */

const M = vi.hoisted(() => ({
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  archivePerson: vi.fn(),
  restorePerson: vi.fn(),
  deletePerson: vi.fn(),
  assignAsset: vi.fn(),
  returnAsset: vi.fn(),
  resolveAssetId: vi.fn(),
  getCurrentUser: vi.fn(),
  hasPermission: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/db/people", () => ({
  createPerson: M.createPerson,
  updatePerson: M.updatePerson,
  archivePerson: M.archivePerson,
  restorePerson: M.restorePerson,
  deletePerson: M.deletePerson,
}));
vi.mock("@/db/assignments", () => ({
  assignAsset: M.assignAsset,
  returnAsset: M.returnAsset,
  resolveAssetId: M.resolveAssetId,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: M.getCurrentUser,
  hasPermission: M.hasPermission,
}));
vi.mock("next/cache", () => ({ revalidatePath: M.revalidatePath }));

import {
  createPersonAction,
  updatePersonAction,
  archivePersonAction,
  restorePersonAction,
  deletePersonAction,
  assignAssetAction,
  returnAssetAction,
} from "./people-actions";
import { EMPTY_PERSON_FORM } from "@/lib/person-schema";

const ASSET_TAG = "OPUS-PHN-7495";
const PERSON = "22222222-2222-4222-8222-222222222222";

/** A complete form payload, as the real client dialog always sends. */
const form = (overrides: Partial<typeof EMPTY_PERSON_FORM>) => ({
  ...EMPTY_PERSON_FORM,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a signed-in admin who can write.
  M.getCurrentUser.mockResolvedValue({ email: "admin@opus.local", permissions: ["asset:write"] });
  M.hasPermission.mockReturnValue(true);
});

describe("the asset:write gate (AC-10)", () => {
  it("forbids every mutation for a caller without asset:write, and writes nothing", async () => {
    M.hasPermission.mockReturnValue(false);

    const results = await Promise.all([
      createPersonAction({ name: "X" }),
      updatePersonAction(PERSON, { name: "X" }),
      archivePersonAction(PERSON),
      restorePersonAction(PERSON),
      deletePersonAction(PERSON),
      assignAssetAction(ASSET_TAG, PERSON),
      returnAssetAction(ASSET_TAG),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/permission/i);
    }
    expect(M.createPerson).not.toHaveBeenCalled();
    expect(M.assignAsset).not.toHaveBeenCalled();
    expect(M.returnAsset).not.toHaveBeenCalled();
    expect(M.archivePerson).not.toHaveBeenCalled();
    expect(M.hasPermission).toHaveBeenCalledWith(expect.anything(), "asset:write");
  });
});

describe("createPersonAction (AC-1, AC-3)", () => {
  it("creates a valid person and revalidates the directory", async () => {
    M.createPerson.mockResolvedValue({ ok: true, id: "p1" });
    const res = await createPersonAction(form({ name: "Grace Park" }));
    expect(res).toEqual({ ok: true, message: "Added Grace Park." });
    expect(M.revalidatePath).toHaveBeenCalledWith("/people");
  });

  it("rejects a blank name before touching the DB (AC-1)", async () => {
    const res = await createPersonAction(form({ name: "   " }));
    expect(res.ok).toBe(false);
    expect(M.createPerson).not.toHaveBeenCalled();
  });

  it("maps a duplicate email to a clear message (AC-3)", async () => {
    M.createPerson.mockResolvedValue({ ok: false, error: "duplicate-email" });
    const res = await createPersonAction(form({ name: "Dup", email: "dup@x.com" }));
    expect(res).toEqual({ ok: false, error: "That email is already used by someone else." });
  });

  it("maps a duplicate employee id to a clear message (AC-3)", async () => {
    M.createPerson.mockResolvedValue({ ok: false, error: "duplicate-employee" });
    const res = await createPersonAction(form({ name: "Dup", employeeId: "E-1" }));
    expect(res).toEqual({ ok: false, error: "That employee id is already used by someone else." });
  });
});

describe("updatePersonAction (AC-1, AC-10)", () => {
  it("rejects a missing id", async () => {
    const res = await updatePersonAction("", { name: "X" });
    expect(res).toEqual({ ok: false, error: "Unknown person." });
  });

  it("updates and returns success", async () => {
    M.updatePerson.mockResolvedValue({ ok: true });
    const res = await updatePersonAction(PERSON, form({ name: "Edited" }));
    expect(res).toEqual({ ok: true, message: "Person updated." });
  });
});

describe("archive / restore / delete (AC-8, AC-9)", () => {
  it("archives with the acting admin's email and reports the pool return", async () => {
    M.archivePerson.mockResolvedValue(true);
    const res = await archivePersonAction(PERSON);
    expect(M.archivePerson).toHaveBeenCalledWith(PERSON, "admin@opus.local");
    expect(res.ok).toBe(true);
    expect(res.ok && res.message).toMatch(/returned to the pool/i);
  });

  it("reports a missing person on archive", async () => {
    M.archivePerson.mockResolvedValue(false);
    const res = await archivePersonAction(PERSON);
    expect(res).toEqual({ ok: false, error: "That person no longer exists." });
  });

  it("restores an archived person", async () => {
    M.restorePerson.mockResolvedValue(true);
    const res = await restorePersonAction(PERSON);
    expect(res.ok).toBe(true);
  });

  it("refuses to delete a person with history and suggests archiving (AC-9)", async () => {
    M.deletePerson.mockResolvedValue("has-history");
    const res = await deletePersonAction(PERSON);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/archive/i);
  });

  it("deletes a person with no history (AC-9)", async () => {
    M.deletePerson.mockResolvedValue("ok");
    const res = await deletePersonAction(PERSON);
    expect(res).toEqual({ ok: true, message: "Person deleted." });
  });
});

describe("assignAssetAction (AC-5)", () => {
  it("resolves the tag then routes through the engine on success", async () => {
    M.resolveAssetId.mockResolvedValue("asset-uuid");
    M.assignAsset.mockResolvedValue({ ok: true });
    const res = await assignAssetAction(ASSET_TAG, PERSON);
    expect(M.resolveAssetId).toHaveBeenCalledWith(ASSET_TAG);
    expect(M.assignAsset).toHaveBeenCalledWith("asset-uuid", PERSON, "admin@opus.local");
    expect(res).toEqual({ ok: true, message: "Device assigned." });
  });

  it("errors when the device tag resolves to nothing", async () => {
    M.resolveAssetId.mockResolvedValue(null);
    const res = await assignAssetAction(ASSET_TAG, PERSON);
    expect(res.ok).toBe(false);
    expect(M.assignAsset).not.toHaveBeenCalled();
  });

  it("maps an archived assignee to a clear message (AC-8)", async () => {
    M.resolveAssetId.mockResolvedValue("asset-uuid");
    M.assignAsset.mockResolvedValue({ ok: false, error: "person-archived" });
    const res = await assignAssetAction(ASSET_TAG, PERSON);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/archived/i);
  });

  it("maps a lost double-assign race to a try-again message (AC-5)", async () => {
    M.resolveAssetId.mockResolvedValue("asset-uuid");
    M.assignAsset.mockResolvedValue({ ok: false, error: "already-assigned" });
    const res = await assignAssetAction(ASSET_TAG, PERSON);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/just assigned to someone else/i);
  });

  it("requires a person to assign to", async () => {
    const res = await assignAssetAction(ASSET_TAG, "");
    expect(res.ok).toBe(false);
    expect(M.resolveAssetId).not.toHaveBeenCalled();
  });
});

describe("returnAssetAction (AC-6)", () => {
  it("returns a currently-assigned device", async () => {
    M.resolveAssetId.mockResolvedValue("asset-uuid");
    M.returnAsset.mockResolvedValue({ ok: true, changed: true });
    const res = await returnAssetAction(ASSET_TAG);
    expect(res).toEqual({ ok: true, message: "Device returned to the pool." });
  });

  it("reports a no-op when the device was not assigned", async () => {
    M.resolveAssetId.mockResolvedValue("asset-uuid");
    M.returnAsset.mockResolvedValue({ ok: true, changed: false });
    const res = await returnAssetAction(ASSET_TAG);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/isn't currently assigned/i);
  });
});
