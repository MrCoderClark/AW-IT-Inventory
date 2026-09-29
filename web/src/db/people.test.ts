import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the people directory data module (spec 16). The DB client is the
 * boundary and is mocked; the real logic under test is initials derivation, the
 * email/employee-id uniqueness checks, and the person lifecycle (create, update,
 * archive, delete-only-without-history). Traces:
 *   AC-1 deriveInitials, createPerson/updatePerson happy paths
 *   AC-3 email + employee-id uniqueness (pre-check and the 23505 race)
 *   AC-8 archivePerson closes open assignments and clears each assigneeId
 *   AC-9 deletePerson refused with history, allowed without
 */

const H = vi.hoisted(() => {
  const state: {
    selectResults: unknown[][];
    updateReturnings: unknown[][];
    insertReturning: unknown[];
    insertError: (Error & { code?: string; constraint_name?: string }) | null;
    deleteReturning: unknown[];
    sets: Record<string, unknown>[];
    inserts: unknown[];
  } = {
    selectResults: [],
    updateReturnings: [],
    insertReturning: [],
    insertError: null,
    deleteReturning: [],
    sets: [],
    inserts: [],
  };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"]) {
      b[m] = self;
    }
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResults.shift() ?? []).then(res, rej);
    return b;
  };
  const select = vi.fn(() => makeSelect());

  const makeWhereAfterUpdate = () => {
    const p = Promise.resolve(undefined) as Promise<unknown> & {
      returning?: () => Promise<unknown>;
    };
    p.returning = () => Promise.resolve(state.updateReturnings.shift() ?? []);
    return p;
  };
  const update = vi.fn(() => ({
    set: (vals: Record<string, unknown>) => {
      state.sets.push(vals);
      return { where: () => makeWhereAfterUpdate() };
    },
  }));

  const insert = vi.fn(() => ({
    values: (rows: unknown) => {
      state.inserts.push(rows);
      return {
        returning: () =>
          state.insertError
            ? Promise.reject(state.insertError)
            : Promise.resolve(state.insertReturning),
      };
    },
  }));

  const del = vi.fn(() => ({
    where: () => ({ returning: () => Promise.resolve(state.deleteReturning) }),
  }));

  const tx = { select, update, insert, delete: del };
  const transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(tx));

  return { state, select, update, insert, del, transaction };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.select,
    update: H.update,
    insert: H.insert,
    delete: H.del,
    transaction: H.transaction,
  },
}));
// people.ts imports getLocationPathMap for the directory reads (not under test here).
vi.mock("@/db/queries", () => ({ getLocationPathMap: vi.fn(async () => new Map()) }));

import {
  deriveInitials,
  escapeLike,
  createPerson,
  updatePerson,
  archivePerson,
  deletePerson,
} from "./people";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  H.state.selectResults = [];
  H.state.updateReturnings = [];
  H.state.insertReturning = [];
  H.state.insertError = null;
  H.state.deleteReturning = [];
  H.state.sets = [];
  H.state.inserts = [];
  vi.clearAllMocks();
});

describe("deriveInitials (AC-1)", () => {
  it("takes the first letter of the first and last words, uppercased", () => {
    expect(deriveInitials("Sarah Jenkins")).toBe("SJ");
    expect(deriveInitials("mary jane watson")).toBe("MW");
  });
  it("gives one letter for a single word", () => {
    expect(deriveInitials("Cher")).toBe("C");
  });
  it("trims surrounding and collapses inner whitespace", () => {
    expect(deriveInitials("  Ana   López  ")).toBe("AL");
  });
  it("returns a placeholder for an empty name", () => {
    expect(deriveInitials("")).toBe("?");
    expect(deriveInitials("   ")).toBe("?");
  });
});

describe("escapeLike (search wildcard safety)", () => {
  it("escapes LIKE wildcards and the escape character, leaving plain text alone", () => {
    expect(escapeLike("finance")).toBe("finance");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });
});

describe("createPerson (AC-1, AC-3)", () => {
  const base = {
    name: "New Person",
    email: null,
    department: null,
    jobTitle: null,
    phone: null,
    employeeId: null,
    officeLocationId: null,
  };

  it("inserts with derived initials and returns the new id", async () => {
    H.state.insertReturning = [{ id: "p1" }];
    const res = await createPerson(base);
    expect(res).toEqual({ ok: true, id: "p1" });
    expect(H.state.inserts[0]).toMatchObject({
      name: "New Person",
      initials: "NP",
    });
  });

  it("rejects an empty name without touching the DB", async () => {
    const res = await createPerson({ ...base, name: "   " });
    expect(res).toEqual({ ok: false, error: "empty-name" });
    expect(H.insert).not.toHaveBeenCalled();
  });

  it("rejects a duplicate email found by the pre-check (AC-3)", async () => {
    H.state.selectResults = [[{ id: "other" }]]; // emailTaken → someone else
    const res = await createPerson({ ...base, email: "dup@x.com" });
    expect(res).toEqual({ ok: false, error: "duplicate-email" });
    expect(H.insert).not.toHaveBeenCalled();
  });

  it("rejects a duplicate employee id found by the pre-check (AC-3)", async () => {
    // email null → no email query; employeeId set → one select returns a row.
    H.state.selectResults = [[{ id: "other" }]];
    const res = await createPerson({ ...base, employeeId: "EMP-1" });
    expect(res).toEqual({ ok: false, error: "duplicate-employee" });
  });

  it("maps a unique-violation race on insert to a duplicate (AC-3)", async () => {
    H.state.insertError = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "people_email_lower_uq",
    });
    const res = await createPerson(base);
    expect(res).toEqual({ ok: false, error: "duplicate-email" });
  });
});

describe("updatePerson (AC-1, AC-3)", () => {
  const input = {
    name: "Edited",
    email: null,
    department: null,
    jobTitle: null,
    phone: null,
    employeeId: null,
    officeLocationId: null,
  };

  it("re-derives initials and updates on success", async () => {
    H.state.updateReturnings = [[{ id: UUID }]];
    const res = await updatePerson(UUID, input);
    expect(res).toEqual({ ok: true });
    expect(H.state.sets[0]).toMatchObject({ name: "Edited", initials: "E" });
  });

  it("returns not-found for a malformed id without querying", async () => {
    const res = await updatePerson("not-a-uuid", input);
    expect(res).toEqual({ ok: false, error: "not-found" });
    expect(H.update).not.toHaveBeenCalled();
  });

  it("returns not-found when no row matched the id", async () => {
    H.state.updateReturnings = [[]];
    const res = await updatePerson(UUID, input);
    expect(res).toEqual({ ok: false, error: "not-found" });
  });

  it("rejects a duplicate email held by someone else, excluding self (AC-3)", async () => {
    H.state.selectResults = [[{ id: "someone-else" }]];
    const res = await updatePerson(UUID, { ...input, email: "dup@x.com" });
    expect(res).toEqual({ ok: false, error: "duplicate-email" });
  });

  it("allows keeping the person's own email (self excluded, AC-3)", async () => {
    // The only match is the person themselves → not taken → update proceeds.
    H.state.selectResults = [[{ id: UUID }]];
    H.state.updateReturnings = [[{ id: UUID }]];
    const res = await updatePerson(UUID, { ...input, email: "mine@x.com" });
    expect(res).toEqual({ ok: true });
  });
});

describe("archivePerson (AC-8)", () => {
  it("archives, closes each open assignment, and clears each device's assigneeId", async () => {
    // 1) update people → row found; 2) update assignments → two closed rows.
    H.state.updateReturnings = [
      [{ id: UUID }],
      [{ assetId: "asset-1" }, { assetId: "asset-2" }],
    ];
    const res = await archivePerson(UUID, "admin@opus.local");
    expect(res).toBe(true);
    // The person is set archived.
    expect(H.state.sets[0]).toMatchObject({ status: "archived" });
    // The open assignments are closed by the acting admin.
    expect(H.state.sets[1]).toMatchObject({ unassignedBy: "admin@opus.local" });
    // The returned devices have their assigneeId cleared in one batched update.
    const cleared = H.state.sets.filter((s) => s.assigneeId === null);
    expect(cleared).toHaveLength(1);
  });

  it("returns false when the person does not exist (no assignments touched)", async () => {
    H.state.updateReturnings = [[]]; // people update matched nothing
    const res = await archivePerson(UUID, "admin@opus.local");
    expect(res).toBe(false);
    // Only the people update ran; no assignment/asset clears.
    expect(H.state.sets.filter((s) => s.assigneeId === null)).toHaveLength(0);
  });

  it("returns false for a malformed id", async () => {
    expect(await archivePerson("nope", "admin@opus.local")).toBe(false);
    expect(H.transaction).not.toHaveBeenCalled();
  });
});

describe("deletePerson (AC-9)", () => {
  it("refuses to delete a person who has any assignment history", async () => {
    H.state.selectResults = [[{ id: "assignment-1" }]]; // history exists
    const res = await deletePerson(UUID);
    expect(res).toBe("has-history");
    expect(H.del).not.toHaveBeenCalled();
  });

  it("deletes a person with no history", async () => {
    H.state.selectResults = [[]]; // no history
    H.state.deleteReturning = [{ id: UUID }];
    const res = await deletePerson(UUID);
    expect(res).toBe("ok");
  });

  it("returns not-found when the delete matched nothing", async () => {
    H.state.selectResults = [[]];
    H.state.deleteReturning = [];
    expect(await deletePerson(UUID)).toBe("not-found");
  });

  it("returns not-found for a malformed id without querying", async () => {
    expect(await deletePerson("bad")).toBe("not-found");
    expect(H.select).not.toHaveBeenCalled();
  });
});
