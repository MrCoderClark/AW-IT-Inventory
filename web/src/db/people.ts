import "server-only";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "./index";
import { assetAssignments, assets, people } from "./schema";
import { getLocationPathMap } from "./queries";
import type { DirectoryPerson, PersonStatus } from "@/lib/data";

/**
 * People directory (spec 16). The managed set of staff who use the fleet. People
 * live in the inventory DB with no aw-auth login link. This `server-only` module
 * owns the directory reads (list/search/count, get one) and the person lifecycle
 * writes (create, update, archive, restore, delete-only-without-history), plus
 * initials derivation and the email/employee-id uniqueness checks. The custody
 * log itself lives in the assignment engine (`src/db/assignments.ts`); archive
 * closes a person's open assignments here, in one transaction, since it is a
 * person-lifecycle event.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** postgres.js surfaces a unique-constraint violation as SQLSTATE 23505. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
}

/**
 * Escape the LIKE wildcards (`%`, `_`) and the escape char itself in a user search
 * term, so a name or department containing them matches literally rather than as a
 * pattern. Postgres LIKE uses backslash as the default escape character.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Which unique index a 23505 is about, so email vs employee-id get distinct
   messages. Falls back to email (the more common case). */
function uniqueField(err: unknown): "email" | "employee" {
  const constraint = String(
    (err as { constraint_name?: unknown })?.constraint_name ?? "",
  );
  return constraint.includes("employee") ? "employee" : "email";
}

/**
 * Derive initials from a name (AC-1): first letter of the first word plus first
 * letter of the last word, uppercased (a single word gives one letter). Always
 * computed on write, never entered by the user. Empty name → "?".
 */
export function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** The validated write shape (the action coerces blanks to null before here). */
export interface PersonWriteInput {
  name: string;
  email: string | null;
  department: string | null;
  jobTitle: string | null;
  phone: string | null;
  employeeId: string | null;
  officeLocationId: string | null;
}

export type PersonWriteError =
  | "empty-name"
  | "duplicate-email"
  | "duplicate-employee"
  | "not-found";

export type CreatePersonResult =
  | { ok: true; id: string }
  | { ok: false; error: PersonWriteError };

export type UpdatePersonResult =
  | { ok: true }
  | { ok: false; error: PersonWriteError };

/* ---------------- Reads (AC-2, AC-4 profile) ---------------- */

export interface DirectoryQuery {
  search?: string;
  includeArchived?: boolean; // false (default) = active only
}

/**
 * The directory list (AC-2): each person with the count of devices they hold
 * now (open assignments). Active people only unless `includeArchived`. `search`
 * matches name, email, department, or job title, case-insensitively. Ordered by
 * name. Office location is resolved to its full path.
 */
export async function getDirectoryPeople(
  query: DirectoryQuery = {},
): Promise<DirectoryPerson[]> {
  const conds = [];
  if (!query.includeArchived) conds.push(eq(people.status, "active"));
  const term = query.search?.trim().toLowerCase();
  if (term) {
    const like = `%${escapeLike(term)}%`;
    conds.push(
      or(
        sql`lower(${people.name}) like ${like}`,
        sql`lower(${people.email}) like ${like}`,
        sql`lower(${people.department}) like ${like}`,
        sql`lower(${people.jobTitle}) like ${like}`,
      ),
    );
  }

  const [rows, pathById] = await Promise.all([
    db
      .select({
        id: people.id,
        name: people.name,
        initials: people.initials,
        email: people.email,
        department: people.department,
        jobTitle: people.jobTitle,
        phone: people.phone,
        employeeId: people.employeeId,
        officeLocationId: people.officeLocationId,
        status: people.status,
        deviceCount: sql<number>`count(${assetAssignments.id})::int`,
      })
      .from(people)
      // Only OPEN assignments count toward "current devices".
      .leftJoin(
        assetAssignments,
        and(
          eq(assetAssignments.personId, people.id),
          isNull(assetAssignments.unassignedAt),
        ),
      )
      .where(conds.length ? and(...conds) : undefined)
      .groupBy(people.id)
      .orderBy(asc(sql`lower(${people.name})`)),
    getLocationPathMap(),
  ]);

  return rows.map((r) => toDirectoryPerson(r, pathById));
}

type PersonRow = {
  id: string;
  name: string;
  initials: string;
  email: string | null;
  department: string | null;
  jobTitle: string | null;
  phone: string | null;
  employeeId: string | null;
  officeLocationId: string | null;
  status: PersonStatus;
  deviceCount: number;
};

function toDirectoryPerson(
  r: PersonRow,
  pathById: Map<string, string>,
): DirectoryPerson {
  return {
    id: r.id,
    name: r.name,
    initials: r.initials,
    email: r.email ?? "",
    department: r.department ?? "",
    jobTitle: r.jobTitle ?? "",
    phone: r.phone ?? "",
    employeeId: r.employeeId ?? "",
    officeLocation: r.officeLocationId
      ? pathById.get(r.officeLocationId) ?? ""
      : "",
    officeLocationId: r.officeLocationId,
    status: r.status,
    deviceCount: r.deviceCount,
  };
}

/** One person by id (AC-4 profile), or null for an unknown/malformed id. */
export async function getPersonById(
  id: string,
): Promise<DirectoryPerson | null> {
  if (!UUID_RE.test(id)) return null;
  const [rows, pathById] = await Promise.all([
    db
      .select({
        id: people.id,
        name: people.name,
        initials: people.initials,
        email: people.email,
        department: people.department,
        jobTitle: people.jobTitle,
        phone: people.phone,
        employeeId: people.employeeId,
        officeLocationId: people.officeLocationId,
        status: people.status,
        deviceCount: sql<number>`count(${assetAssignments.id})::int`,
      })
      .from(people)
      .leftJoin(
        assetAssignments,
        and(
          eq(assetAssignments.personId, people.id),
          isNull(assetAssignments.unassignedAt),
        ),
      )
      .where(eq(people.id, id))
      .groupBy(people.id)
      .limit(1),
    getLocationPathMap(),
  ]);
  const row = rows[0];
  return row ? toDirectoryPerson(row, pathById) : null;
}

/**
 * One person by email (case-insensitive), or null when the email is blank or
 * unmatched. This is how a People record is linked to an aw-auth login: the two
 * are the same human when their emails match. Email is unique-when-present among
 * people, so at most one row comes back.
 */
export async function getPersonByEmail(
  email: string | null | undefined,
): Promise<DirectoryPerson | null> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  const [rows, pathById] = await Promise.all([
    db
      .select({
        id: people.id,
        name: people.name,
        initials: people.initials,
        email: people.email,
        department: people.department,
        jobTitle: people.jobTitle,
        phone: people.phone,
        employeeId: people.employeeId,
        officeLocationId: people.officeLocationId,
        status: people.status,
        deviceCount: sql<number>`count(${assetAssignments.id})::int`,
      })
      .from(people)
      .leftJoin(
        assetAssignments,
        and(
          eq(assetAssignments.personId, people.id),
          isNull(assetAssignments.unassignedAt),
        ),
      )
      .where(sql`lower(${people.email}) = ${normalized}`)
      .groupBy(people.id)
      .limit(1),
    getLocationPathMap(),
  ]);
  const row = rows[0];
  return row ? toDirectoryPerson(row, pathById) : null;
}

/* ---------------- Uniqueness helpers (AC-3) ---------------- */

/** Is this email already used by another person? Case-insensitive; a blank email
   never collides. `exceptId` excludes the person being edited. */
async function emailTaken(
  email: string | null,
  exceptId?: string,
): Promise<boolean> {
  if (!email) return false;
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(sql`lower(${people.email}) = ${email.toLowerCase()}`)
    .limit(2);
  return rows.some((r) => r.id !== exceptId);
}

/** Is this employee id already used by another person? A blank id never collides. */
async function employeeIdTaken(
  employeeId: string | null,
  exceptId?: string,
): Promise<boolean> {
  if (!employeeId) return false;
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.employeeId, employeeId))
    .limit(2);
  return rows.some((r) => r.id !== exceptId);
}

/* ---------------- Writes (AC-1, AC-3, AC-8, AC-9) ---------------- */

/** Create a person (AC-1). Name required; initials derived. Email and employee
   id must be unique when present (AC-3). Callers gate on `asset:write`. */
export async function createPerson(
  input: PersonWriteInput,
): Promise<CreatePersonResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "empty-name" };

  if (await emailTaken(input.email)) {
    return { ok: false, error: "duplicate-email" };
  }
  if (await employeeIdTaken(input.employeeId)) {
    return { ok: false, error: "duplicate-employee" };
  }

  try {
    const [row] = await db
      .insert(people)
      .values({
        name,
        initials: deriveInitials(name),
        email: input.email,
        department: input.department,
        jobTitle: input.jobTitle,
        phone: input.phone,
        employeeId: input.employeeId,
        officeLocationId: input.officeLocationId,
      })
      .returning({ id: people.id });
    return { ok: true, id: row.id };
  } catch (err) {
    // Covers the race the pre-check can't (two concurrent inserts).
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error:
          uniqueField(err) === "employee"
            ? "duplicate-employee"
            : "duplicate-email",
      };
    }
    throw err;
  }
}

/** Edit a person (AC-1). Initials are re-derived from the new name. Uniqueness
   excludes the person themselves (AC-3). Callers gate on `asset:write`. */
export async function updatePerson(
  id: string,
  input: PersonWriteInput,
): Promise<UpdatePersonResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "not-found" };
  const name = input.name.trim();
  if (!name) return { ok: false, error: "empty-name" };

  if (await emailTaken(input.email, id)) {
    return { ok: false, error: "duplicate-email" };
  }
  if (await employeeIdTaken(input.employeeId, id)) {
    return { ok: false, error: "duplicate-employee" };
  }

  try {
    const updated = await db
      .update(people)
      .set({
        name,
        initials: deriveInitials(name),
        email: input.email,
        department: input.department,
        jobTitle: input.jobTitle,
        phone: input.phone,
        employeeId: input.employeeId,
        officeLocationId: input.officeLocationId,
        updatedAt: new Date(),
      })
      .where(eq(people.id, id))
      .returning({ id: people.id });
    if (!updated.length) return { ok: false, error: "not-found" };
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error:
          uniqueField(err) === "employee"
            ? "duplicate-employee"
            : "duplicate-email",
      };
    }
    throw err;
  }
}

/**
 * Archive a person (AC-8): set status to archived, close every open assignment
 * (recording who/when), and clear each returned device's `assigneeId` — all in
 * one transaction so the pool and the log never drift. An archived person drops
 * from the assignee picker (which lists active people only). Returns false when
 * the person doesn't exist.
 */
export async function archivePerson(
  id: string,
  actorEmail: string,
  when: Date = new Date(),
): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(people)
      .set({ status: "archived", updatedAt: when })
      .where(eq(people.id, id))
      .returning({ id: people.id });
    if (!row) return false;

    // Close the person's open assignments and return those devices to the pool.
    const closed = await tx
      .update(assetAssignments)
      .set({ unassignedAt: when, unassignedBy: actorEmail, updatedAt: when })
      .where(
        and(
          eq(assetAssignments.personId, id),
          isNull(assetAssignments.unassignedAt),
        ),
      )
      .returning({ assetId: assetAssignments.assetId });

    // Clear every returned device's assigneeId in one statement (not per row).
    if (closed.length) {
      await tx
        .update(assets)
        .set({ assigneeId: null, updatedAt: when })
        .where(inArray(assets.id, closed.map((c) => c.assetId)));
    }
    return true;
  });
}

/** Restore an archived person to active (AC-8). Their devices are NOT
   reassigned. Returns false when the person doesn't exist. */
export async function restorePerson(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const updated = await db
    .update(people)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(people.id, id))
    .returning({ id: people.id });
  return updated.length > 0;
}

export type DeletePersonResult = "ok" | "not-found" | "has-history";

/**
 * Permanently delete a person, allowed only when they have NO assignment history
 * at all (AC-9). With any history, delete is refused (archive is the only
 * removal). The `on delete restrict` FK is the hard backstop; this pre-check
 * gives the clean message.
 */
export async function deletePerson(id: string): Promise<DeletePersonResult> {
  if (!UUID_RE.test(id)) return "not-found";

  const history = await db
    .select({ id: assetAssignments.id })
    .from(assetAssignments)
    .where(eq(assetAssignments.personId, id))
    .limit(1);
  if (history.length) return "has-history";

  const deleted = await db
    .delete(people)
    .where(eq(people.id, id))
    .returning({ id: people.id });
  return deleted.length ? "ok" : "not-found";
}
