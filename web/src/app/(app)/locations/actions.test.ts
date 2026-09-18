import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock only the true boundaries: the DB client, the auth/session lookup, Next's
// cache revalidation, and the read-only query helpers the actions lean on. The
// zod schema and the guard logic run for real. These lock in the spec 09
// integrity guards: unique sibling names (AC-2), no cycles (AC-4),
// block-until-empty delete (AC-5), leaf-only nesting (AC-7), the location:write
// gate (AC-9), and the "no longer exists" paths (AC-11).
const h = vi.hoisted(() => {
  const insertValues = vi.fn(); // db.insert(x).values(y) terminal
  const returning = vi.fn(); // .returning() terminal for update/delete
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => insertValues());
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => returning());

  const db = {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
  };

  return {
    insertValues,
    returning,
    chain,
    db,
    getCurrentUser: vi.fn(),
    hasPermission: vi.fn(),
    revalidatePath: vi.fn(),
    getLocationById: vi.fn(),
    getSubtreeIds: vi.fn(),
    locationHasChildren: vi.fn(),
    locationHasDevices: vi.fn(),
    siblingNameTaken: vi.fn(),
  };
});

vi.mock("@/db/index", () => ({ db: h.db }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: h.getCurrentUser,
  hasPermission: h.hasPermission,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/db/queries", () => ({
  getLocationById: h.getLocationById,
  getSubtreeIds: h.getSubtreeIds,
  locationHasChildren: h.locationHasChildren,
  locationHasDevices: h.locationHasDevices,
  siblingNameTaken: h.siblingNameTaken,
}));

import {
  createLocation,
  renameLocation,
  moveLocation,
  deleteLocation,
} from "./actions";

const A_UUID = "550e8400-e29b-41d4-a716-446655440000";
const B_UUID = "660e8400-e29b-41d4-a716-446655440111";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a signed-in user who can manage locations, and every guard clear.
  h.getCurrentUser.mockResolvedValue({ id: "u1", permissions: ["location:write"] });
  h.hasPermission.mockReturnValue(true);
  h.insertValues.mockResolvedValue(undefined);
  h.returning.mockResolvedValue([{ id: "loc1" }]);
  h.getLocationById.mockImplementation(async (id: string) => ({
    id,
    name: `Loc ${id}`,
    parentId: null,
  }));
  h.getSubtreeIds.mockResolvedValue([A_UUID]);
  h.locationHasChildren.mockResolvedValue(false);
  h.locationHasDevices.mockResolvedValue(false);
  h.siblingNameTaken.mockResolvedValue(false);
});

describe("createLocation (AC-2, AC-7, AC-9)", () => {
  it("creates a top-level location on valid input", async () => {
    const res = await createLocation({ name: "New York", parentId: null });
    expect(res).toEqual({ ok: true, message: 'Created "New York".' });
    expect(h.db.insert).toHaveBeenCalledTimes(1);
  });

  it("creates a child when the parent exists and holds no devices", async () => {
    const res = await createLocation({ name: "Bronx", parentId: A_UUID });
    expect(res.ok).toBe(true);
    expect(h.db.insert).toHaveBeenCalledTimes(1);
  });

  // covers: AC-9
  it("forbids a caller without location:write and does not write", async () => {
    h.hasPermission.mockReturnValue(false);
    const res = await createLocation({ name: "New York", parentId: null });
    expect(res).toEqual({
      ok: false,
      error: "You don't have permission to do that.",
    });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.hasPermission).toHaveBeenCalledWith(
      expect.anything(),
      "location:write",
    );
  });

  // covers: AC-2
  it("rejects a blank name without writing", async () => {
    const res = await createLocation({ name: "", parentId: null });
    expect(res.ok).toBe(false);
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  // covers: AC-2
  it("rejects a duplicate sibling name", async () => {
    h.siblingNameTaken.mockResolvedValue(true);
    const res = await createLocation({ name: "Bronx", parentId: A_UUID });
    expect(res).toEqual({
      ok: false,
      error: 'A location named "Bronx" already exists here.',
    });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  // covers: AC-7 (adding a child to a location that holds devices is blocked)
  it("rejects a child under a parent that has devices assigned", async () => {
    h.locationHasDevices.mockResolvedValue(true);
    const res = await createLocation({ name: "Room A", parentId: A_UUID });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({
      error: expect.stringContaining("devices assigned"),
    });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  // covers: AC-11
  it("rejects when the parent no longer exists", async () => {
    h.getLocationById.mockResolvedValue(null);
    const res = await createLocation({ name: "Bronx", parentId: A_UUID });
    expect(res).toEqual({
      ok: false,
      error: "That parent location no longer exists.",
    });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  // covers: AC-2 (a concurrent insert trips the unique index)
  it("maps a unique-constraint violation to a clean duplicate error", async () => {
    h.insertValues.mockRejectedValue({ code: "23505" });
    const res = await createLocation({ name: "New York", parentId: null });
    expect(res).toEqual({
      ok: false,
      error: 'A location named "New York" already exists here.',
    });
  });
});

describe("renameLocation (AC-3, AC-9, AC-11)", () => {
  it("renames a location on valid input", async () => {
    const res = await renameLocation(A_UUID, "Woodside");
    expect(res).toEqual({ ok: true, message: 'Renamed to "Woodside".' });
    expect(h.db.update).toHaveBeenCalledTimes(1);
  });

  // covers: AC-9
  it("forbids a caller without location:write", async () => {
    h.hasPermission.mockReturnValue(false);
    const res = await renameLocation(A_UUID, "Woodside");
    expect(res.ok).toBe(false);
    expect(h.db.update).not.toHaveBeenCalled();
  });

  // covers: AC-11
  it("returns a clean error when the location no longer exists", async () => {
    h.getLocationById.mockResolvedValue(null);
    const res = await renameLocation(A_UUID, "Woodside");
    expect(res).toEqual({
      ok: false,
      error: "That location no longer exists. Refresh and try again.",
    });
    expect(h.db.update).not.toHaveBeenCalled();
  });

  // covers: AC-2 (rename can't collide with a sibling)
  it("rejects a duplicate sibling name", async () => {
    h.siblingNameTaken.mockResolvedValue(true);
    const res = await renameLocation(A_UUID, "45th");
    expect(res).toEqual({
      ok: false,
      error: 'A location named "45th" already exists here.',
    });
    expect(h.db.update).not.toHaveBeenCalled();
  });

  // covers: AC-11 (deleted between the read and the update)
  it("returns gone when the update matches no row", async () => {
    h.returning.mockResolvedValue([]);
    const res = await renameLocation(A_UUID, "Woodside");
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ error: expect.stringContaining("no longer exists") });
  });
});

describe("moveLocation (AC-4, AC-7, AC-11)", () => {
  it("moves a location to top level (null parent)", async () => {
    h.getLocationById.mockResolvedValue({ id: A_UUID, name: "Bronx", parentId: B_UUID });
    const res = await moveLocation(A_UUID, null);
    expect(res).toEqual({ ok: true, message: 'Moved "Bronx".' });
    expect(h.db.update).toHaveBeenCalledTimes(1);
  });

  it("moves a location under a valid new parent", async () => {
    h.getSubtreeIds.mockResolvedValue([A_UUID]); // B is not in A's subtree
    const res = await moveLocation(A_UUID, B_UUID);
    expect(res.ok).toBe(true);
  });

  // covers: AC-4 (can't move a location under itself)
  it("rejects moving a location under itself", async () => {
    const res = await moveLocation(A_UUID, A_UUID);
    expect(res).toEqual({
      ok: false,
      error: "A location can't be moved under itself.",
    });
    expect(h.db.update).not.toHaveBeenCalled();
  });

  // covers: AC-4 (cycle: can't move under a descendant)
  it("rejects moving a location under one of its own descendants", async () => {
    h.getSubtreeIds.mockResolvedValue([A_UUID, B_UUID]); // B is a descendant of A
    const res = await moveLocation(A_UUID, B_UUID);
    expect(res).toEqual({
      ok: false,
      error: "A location can't be moved under one of its own descendants.",
    });
    expect(h.db.update).not.toHaveBeenCalled();
  });

  // covers: AC-7 (can't nest under a location that holds devices)
  it("rejects moving under a destination that has devices assigned", async () => {
    h.getSubtreeIds.mockResolvedValue([A_UUID]);
    h.locationHasDevices.mockResolvedValue(true);
    const res = await moveLocation(A_UUID, B_UUID);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({
      error: expect.stringContaining("devices assigned"),
    });
    expect(h.db.update).not.toHaveBeenCalled();
  });

  // covers: AC-11
  it("returns gone when the moved location no longer exists", async () => {
    h.getLocationById.mockResolvedValue(null);
    const res = await moveLocation(A_UUID, B_UUID);
    expect(res).toMatchObject({ error: expect.stringContaining("no longer exists") });
    expect(h.db.update).not.toHaveBeenCalled();
  });

  // covers: AC-11 (destination deleted mid-flight)
  it("rejects when the destination no longer exists", async () => {
    h.getLocationById.mockImplementation(async (id: string) =>
      id === B_UUID ? null : { id, name: `Loc ${id}`, parentId: null },
    );
    const res = await moveLocation(A_UUID, B_UUID);
    expect(res).toEqual({
      ok: false,
      error: "That destination no longer exists.",
    });
  });

  // covers: AC-9
  it("forbids a caller without location:write", async () => {
    h.hasPermission.mockReturnValue(false);
    const res = await moveLocation(A_UUID, B_UUID);
    expect(res.ok).toBe(false);
    expect(h.db.update).not.toHaveBeenCalled();
  });
});

describe("deleteLocation (AC-5, AC-9, AC-11)", () => {
  it("deletes an empty leaf", async () => {
    const res = await deleteLocation(A_UUID);
    expect(res).toEqual({ ok: true, message: `Deleted "Loc ${A_UUID}".` });
    expect(h.db.delete).toHaveBeenCalledTimes(1);
  });

  // covers: AC-5 (block until empty: has children)
  it("refuses to delete a location that has child locations", async () => {
    h.locationHasChildren.mockResolvedValue(true);
    const res = await deleteLocation(A_UUID);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({
      error: expect.stringContaining("child locations"),
    });
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  // covers: AC-5 (block until empty: has devices)
  it("refuses to delete a location that has devices assigned", async () => {
    h.locationHasDevices.mockResolvedValue(true);
    const res = await deleteLocation(A_UUID);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({
      error: expect.stringContaining("devices assigned"),
    });
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  // covers: AC-9
  it("forbids a caller without location:write", async () => {
    h.hasPermission.mockReturnValue(false);
    const res = await deleteLocation(A_UUID);
    expect(res.ok).toBe(false);
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  // covers: AC-11
  it("returns a clean error when the location is already gone", async () => {
    h.getLocationById.mockResolvedValue(null);
    const res = await deleteLocation(A_UUID);
    expect(res).toEqual({
      ok: false,
      error: "That location no longer exists. Refresh and try again.",
    });
    expect(h.db.delete).not.toHaveBeenCalled();
  });

  // covers: AC-5 (a child/device landed in the race; the FK blocks the delete)
  it("maps a foreign-key violation to a 'not empty anymore' error", async () => {
    h.returning.mockRejectedValue({ code: "23503" });
    const res = await deleteLocation(A_UUID);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({
      error: expect.stringContaining("isn't empty anymore"),
    });
  });
});
