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
  // The detail upsert ends the chain and is awaited (spec 10).
  chain.onConflictDoUpdate = vi.fn(() => Promise.resolve([]));
  chain.returning = vi.fn(() => returning());

  const db: Record<string, unknown> = {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
  };
  // createAsset / updateAsset now run inside one transaction; the callback gets a
  // tx with the same chainable insert/update as the top-level db.
  db.transaction = vi.fn(
    async (cb: (tx: unknown) => unknown) => cb(db),
  );
  const getCurrentUser = vi.fn();
  const hasPermission = vi.fn();
  const revalidatePath = vi.fn();
  // The assignment engine is the boundary the asset form now routes through
  // (spec 16, AC-11); spy on its transaction-aware cores.
  const assignAssetTx = vi.fn();
  const returnAssetTx = vi.fn();
  const recordAssignmentAudits = vi.fn(async () => undefined);
  const upsertAudit = vi.fn(async () => ({ ok: true as const, id: "audit-1" }));
  return {
    returning, chain, db, getCurrentUser, hasPermission, revalidatePath,
    assignAssetTx, returnAssetTx, recordAssignmentAudits, upsertAudit,
  };
});

vi.mock("@/db/index", () => ({ db: h.db }));
vi.mock("@/db/computer-audit", () => ({
  upsertAuditEvent: (...args: unknown[]) => h.upsertAudit(...args),
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: h.getCurrentUser,
  hasPermission: h.hasPermission,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/db/assignments", () => ({
  assignAssetTx: h.assignAssetTx,
  returnAssetTx: h.returnAssetTx,
  recordAssignmentAudits: h.recordAssignmentAudits,
  // The FK tests below exercise the real FK path (23503), not this race, so a
  // constant false keeps them unchanged.
  isOpenAssignmentRace: () => false,
}));
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

const PERSON = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a signed-in user who can write, and an empty query result.
  h.getCurrentUser.mockResolvedValue({
    id: "u1",
    email: "admin@x",
    permissions: ["asset:write"],
  });
  h.hasPermission.mockReturnValue(true);
  h.returning.mockResolvedValue([]);
  // The engine succeeds by default; individual tests override.
  h.assignAssetTx.mockResolvedValue({ ok: true });
  h.returnAssetTx.mockResolvedValue({ ok: true, changed: false });
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
    // Two inserts now: the asset row, then its per-type detail row (spec 10).
    expect(h.db.insert).toHaveBeenCalledTimes(2);
  });

  it("generates a tag whose prefix agrees with the type (AC-8)", async () => {
    h.returning.mockResolvedValue([{ tag: "OPUS-MON-ABC12" }]);

    await createAsset(validInput);

    const payload = (h.chain.values as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { tag: string; type: string };
    expect(payload.type).toBe("Monitor");
    expect(payload.tag).toMatch(/^H2TECS-MON-[A-Z0-9]{1,5}$/);
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

  it("writes one audit row per successful Computer save", async () => {
    const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    h.returning.mockResolvedValue([{ id: assetId, assigneeId: null }]);
    const computer = { ...validInput, name: "Front Desk", type: "Computer" as const };

    const res = await updateAsset("H2TECS-PC-ABC12", computer);
    expect(res).toEqual({ ok: true, message: "Asset updated." });
    expect(h.upsertAudit).toHaveBeenCalledTimes(1);
    const first = h.upsertAudit.mock.calls[0][0] as {
      sourceTable: string;
      sourceId: string;
      assetId: string;
      action: string;
      operator: string;
      source: string;
      summary: string;
      status: string;
    };
    expect(first).toMatchObject({
      sourceTable: "asset_updates",
      assetId,
      action: "asset_update",
      operator: "admin@x",
      source: "admin_console",
      summary: "Updated Front Desk",
      status: "succeeded",
    });
    expect(first.sourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    h.upsertAudit.mockClear();
    const again = await updateAsset("H2TECS-PC-ABC12", computer);
    expect(again.ok).toBe(true);
    const second = h.upsertAudit.mock.calls[0][0] as { sourceId: string };
    expect(second.sourceId).not.toBe(first.sourceId);
  });

  it("does not audit a Monitor save", async () => {
    h.returning.mockResolvedValue([{ id: "asset-id", assigneeId: null }]);
    await updateAsset("OPUS-MON-ABC12", validInput);
    expect(h.upsertAudit).not.toHaveBeenCalled();
  });
});

describe("assignee reroute through the assignment engine (spec 16, AC-11)", () => {
  it("createAsset routes the initial assignee through assignAssetTx, never a direct write", async () => {
    h.returning.mockResolvedValue([{ tag: "OPUS-MON-ABC12", id: "asset-id" }]);

    const res = await createAsset({ ...validInput, assigneeId: PERSON });

    expect(res.ok).toBe(true);
    expect(h.assignAssetTx).toHaveBeenCalledWith(
      expect.anything(),
      "asset-id",
      PERSON,
      "admin@x",
    );
    // The asset insert payload no longer carries assigneeId (the engine owns it).
    const insertPayload = (h.chain.values as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(insertPayload).not.toHaveProperty("assigneeId");
    expect(h.recordAssignmentAudits).not.toHaveBeenCalled();
  });

  it("writes a Computer assignment audit after the create transaction commits", async () => {
    const audit = {
      assignmentId: "asg-1",
      assetId: "asset-id",
      actorEmail: "admin@x",
      summary: "Assigned to Ada",
      details: { toPersonId: PERSON, toName: "Ada" },
    };
    h.returning.mockResolvedValue([{ tag: "H2TECS-PC-ABC12", id: "asset-id" }]);
    h.assignAssetTx.mockResolvedValue({ ok: true, audit });
    const order: string[] = [];
    h.db.transaction.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb(h.db);
      order.push("commit");
      return result;
    });
    h.recordAssignmentAudits.mockImplementationOnce(async () => {
      order.push("audit");
    });

    const res = await createAsset({
      ...validInput,
      type: "Computer",
      name: "Front Desk",
      assigneeId: PERSON,
    });

    expect(res.ok).toBe(true);
    expect(order).toEqual(["commit", "audit"]);
    expect(h.recordAssignmentAudits).toHaveBeenCalledWith([audit]);
  });

  it("createAsset rolls back and reports an archived assignee", async () => {
    h.returning.mockResolvedValue([{ tag: "OPUS-MON-ABC12", id: "asset-id" }]);
    h.assignAssetTx.mockResolvedValue({ ok: false, error: "person-archived" });

    const res = await createAsset({ ...validInput, assigneeId: PERSON });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/archived/i);
    expect(h.recordAssignmentAudits).not.toHaveBeenCalled();
  });

  it("createAsset does not call the engine when there is no assignee", async () => {
    h.returning.mockResolvedValue([{ tag: "OPUS-MON-ABC12", id: "asset-id" }]);
    await createAsset(validInput); // assigneeId ""
    expect(h.assignAssetTx).not.toHaveBeenCalled();
  });

  it("updateAsset routes an assignee change through assignAssetTx", async () => {
    h.returning.mockResolvedValue([{ id: "asset-id", assigneeId: null }]);
    await updateAsset("OPUS-MON-ABC12", { ...validInput, assigneeId: PERSON });
    expect(h.assignAssetTx).toHaveBeenCalledWith(
      expect.anything(),
      "asset-id",
      PERSON,
      "admin@x",
    );
  });

  it("writes an assignment audit after the update transaction commits", async () => {
    const audit = {
      assignmentId: "asg-1",
      assetId: "asset-id",
      actorEmail: "admin@x",
      summary: "Assigned to Ada",
      details: { toName: "Ada" },
    };
    h.returning.mockResolvedValue([{ id: "asset-id", assigneeId: null }]);
    h.assignAssetTx.mockResolvedValue({ ok: true, audit });
    const order: string[] = [];
    h.db.transaction.mockImplementationOnce(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const result = await cb(h.db);
        order.push("commit");
        return result;
      },
    );
    h.recordAssignmentAudits.mockImplementationOnce(async () => {
      order.push("audit");
    });

    const res = await updateAsset("H2TECS-PC-ABC12", {
      ...validInput,
      type: "Computer",
      name: "Front Desk",
      assigneeId: PERSON,
    });

    expect(res.ok).toBe(true);
    expect(order[0]).toBe("commit");
    expect(order).toContain("audit");
    expect(h.recordAssignmentAudits).toHaveBeenCalledWith([audit]);
  });

  it("writes a return audit after the update transaction commits", async () => {
    const audit = {
      assignmentId: "asg-1",
      assetId: "asset-id",
      actorEmail: "admin@x",
      summary: "Returned from Ada",
      details: { personId: PERSON, fromName: "Ada" },
    };
    h.returning.mockResolvedValue([{ id: "asset-id", assigneeId: PERSON }]);
    h.returnAssetTx.mockResolvedValue({ ok: true, changed: true, audits: [audit] });
    const order: string[] = [];
    h.db.transaction.mockImplementationOnce(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const result = await cb(h.db);
        order.push("commit");
        return result;
      },
    );
    h.recordAssignmentAudits.mockImplementationOnce(async () => {
      order.push("audit");
    });

    const res = await updateAsset("H2TECS-PC-ABC12", {
      ...validInput,
      type: "Computer",
      name: "Front Desk",
      assigneeId: "",
    });

    expect(res.ok).toBe(true);
    expect(order[0]).toBe("commit");
    expect(h.recordAssignmentAudits).toHaveBeenCalledWith([audit]);
  });

  it("updateAsset returns the device to the pool when the assignee is cleared", async () => {
    h.returning.mockResolvedValue([{ id: "asset-id", assigneeId: "old-person" }]);
    await updateAsset("OPUS-MON-ABC12", { ...validInput, assigneeId: "" });
    expect(h.returnAssetTx).toHaveBeenCalledWith(
      expect.anything(),
      "asset-id",
      "admin@x",
    );
    expect(h.assignAssetTx).not.toHaveBeenCalled();
  });

  it("updateAsset touches neither path when the assignee is unchanged", async () => {
    h.returning.mockResolvedValue([{ id: "asset-id", assigneeId: PERSON }]);
    await updateAsset("OPUS-MON-ABC12", { ...validInput, assigneeId: PERSON });
    expect(h.assignAssetTx).not.toHaveBeenCalled();
    expect(h.returnAssetTx).not.toHaveBeenCalled();
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
