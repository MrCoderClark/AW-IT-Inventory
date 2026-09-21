import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Integration tests for the column-config Server Actions (spec 11). The DB, the
 * auth session, and Next's cache are the true boundaries, so they are mocked;
 * the sanitize logic (from table-columns) runs for real. These lock in the two
 * criteria that `/check verify` could not exercise at runtime: the server-side
 * permission gate (AC-8) and re-validation of the submitted ids before writing
 * (AC-6), plus the global save/reset + revalidate path (AC-5).
 */

const {
  insertMock,
  valuesMock,
  onConflictMock,
  deleteMock,
  whereMock,
  revalidateMock,
  getCurrentUserMock,
  hasPermissionMock,
} = vi.hoisted(() => {
  const onConflictMock = vi.fn(() => Promise.resolve());
  const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  const whereMock = vi.fn(() => Promise.resolve());
  const deleteMock = vi.fn(() => ({ where: whereMock }));
  return {
    insertMock,
    valuesMock,
    onConflictMock,
    deleteMock,
    whereMock,
    revalidateMock: vi.fn(),
    getCurrentUserMock: vi.fn(),
    hasPermissionMock: vi.fn(),
  };
});

vi.mock("@/db/index", () => ({ db: { insert: insertMock, delete: deleteMock } }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
  hasPermission: hasPermissionMock,
}));

import { saveColumnConfig, resetColumnConfig } from "./columns-actions";

/** Grant or deny `columns:write` for a test. getCurrentUser returns a stand-in
   user; hasPermission is what actually decides. */
function grant(allowed: boolean) {
  getCurrentUserMock.mockResolvedValue(allowed ? { id: "u1" } : null);
  hasPermissionMock.mockReturnValue(allowed);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveColumnConfig — permission gate (AC-8)", () => {
  it("rejects a caller without columns:write and writes nothing", async () => {
    grant(false);

    const res = await saveColumnConfig("printer", ["name", "ip", "actions"]);

    expect(res).toEqual({
      ok: false,
      error: "You don't have permission to configure columns.",
    });
    expect(insertMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("checks permission before the view, so a bad view still returns forbidden", async () => {
    grant(false);

    const res = await saveColumnConfig("nonsense", ["name"]);

    expect(res).toMatchObject({ ok: false });
    // The gate wins: it must not leak the "bad view" path to an unauthorized caller.
    expect(res).toEqual({
      ok: false,
      error: "You don't have permission to configure columns.",
    });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("saveColumnConfig — view validation", () => {
  it("rejects an unknown view even for an authorized admin, without writing", async () => {
    grant(true);

    const res = await saveColumnConfig("bogus", ["name", "actions"]);

    expect(res).toEqual({ ok: false, error: "That table view doesn't exist." });
    expect(insertMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe("saveColumnConfig — sanitize before write (AC-6) and save globally (AC-5)", () => {
  it("stores only catalog-valid ids and upserts by view key", async () => {
    grant(true);

    // MAC is not a printer column; it must be dropped before persisting.
    const res = await saveColumnConfig("printer", [
      "name",
      "mac",
      "status",
      "actions",
    ]);

    expect(res).toEqual({ ok: true, message: "Column layout saved for everyone." });
    expect(valuesMock).toHaveBeenCalledTimes(1);
    const written = valuesMock.mock.calls[0][0];
    expect(written.viewKey).toBe("printer");
    expect(written.columns).toEqual(["name", "status", "actions"]);
    expect(written.updatedAt).toBeInstanceOf(Date);
    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });

  it("forces the locked columns into the stored array (Name first, Actions last)", async () => {
    grant(true);

    await saveColumnConfig("printer", ["status", "ip"]);

    const written = valuesMock.mock.calls[0][0].columns as string[];
    expect(written[0]).toBe("name");
    expect(written[written.length - 1]).toBe("actions");
  });

  it("revalidates the edited view's route so every user sees the change", async () => {
    grant(true);

    await saveColumnConfig("printer", ["name", "actions"]);

    expect(revalidateMock).toHaveBeenCalledWith("/printers");
  });

  it("revalidates the location view as a dynamic page route", async () => {
    grant(true);

    await saveColumnConfig("location", ["name", "type", "actions"]);

    expect(revalidateMock).toHaveBeenCalledWith("/locations/[id]", "page");
  });
});

describe("resetColumnConfig (AC-5, AC-8)", () => {
  it("rejects a caller without columns:write and deletes nothing", async () => {
    grant(false);

    const res = await resetColumnConfig("printer");

    expect(res).toEqual({
      ok: false,
      error: "You don't have permission to configure columns.",
    });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown view without deleting", async () => {
    grant(true);

    const res = await resetColumnConfig("bogus");

    expect(res).toEqual({ ok: false, error: "That table view doesn't exist." });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes the saved row and revalidates the view for everyone", async () => {
    grant(true);

    const res = await resetColumnConfig("dashboard");

    expect(res).toEqual({ ok: true, message: "Columns reset to the defaults." });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledWith("/dashboard");
  });
});
