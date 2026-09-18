import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock only the true boundaries: the DB client (a real postgres connection),
// the auth/session lookup, and Next's cache revalidation. The zod schema and
// the tag helper are ours, so they run for real.
const h = vi.hoisted(() => {
  // One chainable query builder. Every intermediate call returns the builder;
  // the terminal `.returning()` resolves whatever the test configures.
  const returning = vi.fn();
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.onConflictDoNothing = vi.fn(() => chain);
  chain.returning = vi.fn(() => returning());

  const db = {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
  };
  const getCurrentUser = vi.fn();
  const hasPermission = vi.fn();
  const revalidatePath = vi.fn();
  return { returning, chain, db, getCurrentUser, hasPermission, revalidatePath };
});

vi.mock("@/db/index", () => ({ db: h.db }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: h.getCurrentUser,
  hasPermission: h.hasPermission,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
// queries.ts is a `server-only` module; mock the one helper the actions use for
// the leaf check (default: the chosen location is an assignable leaf).
vi.mock("@/db/queries", () => ({
  locationLeafStatus: vi.fn(async () => "leaf" as const),
}));

import { createAsset, updateAsset, deleteAsset } from "./actions";

const validInput = {
  name: "New Monitor",
  type: "Monitor",
  status: "storage",
  serial: "",
  model: "",
  assigneeId: "",
  locationId: "",
  vendor: "",
  spec: "",
  costCenter: "",
  purchaseDate: "",
  warrantyUntil: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a signed-in user who can write, and an empty query result.
  h.getCurrentUser.mockResolvedValue({ id: "u1", permissions: ["asset:write"] });
  h.hasPermission.mockReturnValue(true);
  h.returning.mockResolvedValue([]);
});

describe("createAsset (AC-2, AC-6, AC-8)", () => {
  it("inserts and returns the generated tag on valid input", async () => {
    h.returning.mockResolvedValue([{ tag: "OPUS-MON-ABC12" }]);

    const res = await createAsset(validInput);

    expect(res).toEqual({
      ok: true,
      message: "Created OPUS-MON-ABC12.",
      tag: "OPUS-MON-ABC12",
    });
    expect(h.db.insert).toHaveBeenCalledTimes(1);
  });

  it("generates a tag whose prefix agrees with the type (AC-8)", async () => {
    h.returning.mockResolvedValue([{ tag: "OPUS-MON-ABC12" }]);

    await createAsset(validInput);

    const payload = (h.chain.values as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { tag: string; type: string };
    expect(payload.type).toBe("Monitor");
    expect(payload.tag).toMatch(/^OPUS-MON-[A-Z0-9]{1,5}$/);
  });

  it("retries tag generation on a unique-constraint clash", async () => {
    h.returning
      .mockResolvedValueOnce([]) // first tag clashed
      .mockResolvedValueOnce([{ tag: "OPUS-MON-RETRY" }]);

    const res = await createAsset(validInput);

    expect(res.ok).toBe(true);
    expect(h.chain.returning).toHaveBeenCalledTimes(2);
  });

  it("gives up after repeated clashes without throwing", async () => {
    h.returning.mockResolvedValue([]); // always clashes

    const res = await createAsset(validInput);

    expect(res).toEqual({
      ok: false,
      error: "Couldn't generate a unique tag. Try again.",
    });
    expect(h.chain.returning).toHaveBeenCalledTimes(6);
  });

  it("rejects invalid input without writing (server trust boundary, AC-4)", async () => {
    const res = await createAsset({ ...validInput, name: "" });

    expect(res.ok).toBe(false);
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it("returns a clean error (not a crash) when the assignee was deleted mid-flight", async () => {
    // Postgres FK violation: assigneeId points at a since-deleted person.
    h.returning.mockRejectedValue({ code: "23503" });

    const res = await createAsset({
      ...validInput,
      assigneeId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(res).toEqual({
      ok: false,
      error: "That assignee no longer exists. Refresh and try again.",
    });
  });

  it("forbids a caller without asset:write and does not write (AC-6)", async () => {
    h.hasPermission.mockReturnValue(false);

    const res = await createAsset(validInput);

    expect(res).toEqual({
      ok: false,
      error: "You don't have permission to do that.",
    });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.hasPermission).toHaveBeenCalledWith(
      expect.anything(),
      "asset:write",
    );
  });
});

describe("updateAsset (AC-3, AC-6, AC-7)", () => {
  it("updates an existing asset and reports success", async () => {
    h.returning.mockResolvedValue([{ type: "Monitor" }]);

    const res = await updateAsset("OPUS-MON-ABC12", validInput);

    expect(res).toEqual({ ok: true, message: "Asset updated." });
    expect(h.db.update).toHaveBeenCalledTimes(1);
  });

  it("never writes the type field (type is locked on edit, AC-3)", async () => {
    h.returning.mockResolvedValue([{ type: "Monitor" }]);

    await updateAsset("OPUS-MON-ABC12", validInput);

    const setPayload = (h.chain.set as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty("type");
    expect(setPayload).toHaveProperty("name");
    expect(setPayload).toHaveProperty("status");
  });

  it("returns a clean error when the asset no longer exists (AC-7)", async () => {
    h.returning.mockResolvedValue([]); // nothing matched the tag

    const res = await updateAsset("OPUS-MON-GONE0", validInput);

    expect(res).toEqual({ ok: false, error: "That asset no longer exists." });
  });

  it("rejects invalid input without writing (AC-4)", async () => {
    const res = await updateAsset("OPUS-MON-ABC12", {
      ...validInput,
      status: "",
    });

    expect(res.ok).toBe(false);
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("returns a clean error (not a crash) when the assignee was deleted mid-flight", async () => {
    h.returning.mockRejectedValue({ code: "23503" });

    const res = await updateAsset("OPUS-MON-ABC12", {
      ...validInput,
      assigneeId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(res).toEqual({
      ok: false,
      error: "That assignee no longer exists. Refresh and try again.",
    });
  });

  it("forbids a caller without asset:write (AC-6)", async () => {
    h.hasPermission.mockReturnValue(false);

    const res = await updateAsset("OPUS-MON-ABC12", validInput);

    expect(res.ok).toBe(false);
    expect(h.db.update).not.toHaveBeenCalled();
  });
});

describe("deleteAsset (AC-5, AC-6, AC-7)", () => {
  it("deletes an existing asset and reports success", async () => {
    h.returning.mockResolvedValue([{ type: "Monitor" }]);

    const res = await deleteAsset("OPUS-MON-ABC12");

    expect(res).toEqual({ ok: true, message: "Deleted OPUS-MON-ABC12." });
    expect(h.db.delete).toHaveBeenCalledTimes(1);
  });

  it("revalidates the discovered inbox so an unlinked machine reappears (AC-5)", async () => {
    h.returning.mockResolvedValue([{ type: "Monitor" }]);

    await deleteAsset("OPUS-MON-ABC12");

    expect(h.revalidatePath).toHaveBeenCalledWith("/scans");
  });

  it("returns a clean error when the asset is already gone (AC-7)", async () => {
    h.returning.mockResolvedValue([]);

    const res = await deleteAsset("OPUS-MON-GONE0");

    expect(res).toEqual({ ok: false, error: "That asset no longer exists." });
  });

  it("forbids a caller without asset:write (AC-6)", async () => {
    h.hasPermission.mockReturnValue(false);

    const res = await deleteAsset("OPUS-MON-ABC12");

    expect(res.ok).toBe(false);
    expect(h.db.delete).not.toHaveBeenCalled();
  });
});
