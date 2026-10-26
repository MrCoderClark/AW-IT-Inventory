import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { upsertAuditEvent } from "./computer-audit";
import { db } from "./index";
import { assetAssignments, assets, people } from "./schema";
import type { AssetType, AssignmentEvent, CurrentDevice } from "@/lib/data";

/**
 * Assignment engine (spec 16). The single writer of `assets.assigneeId`: it keeps
 * the denormalized "current holder" in step with the `asset_assignments` custody
 * log, always in one transaction (AC-11). Assigning a device closes any open
 * assignment and opens a new one; returning it closes the open one. At most one
 * open assignment per device is enforced by the DB (the partial unique index) and
 * upheld here. Also the read paths for the device timeline (AC-7) and the person
 * timeline (AC-4).
 *
 * The engine works in asset UUIDs; the tag-facing server actions resolve a tag to
 * its id first (`resolveAssetId`), while the asset form calls in with the id it
 * already holds.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssignError =
  | "asset-not-found"
  | "person-not-found"
  | "person-archived"
  | "already-assigned";

export type AssignResult = { ok: true } | { ok: false; error: AssignError };

/**
 * A Computer assignment change to record after the assignment transaction
 * commits. Built inside the transaction (it needs the row id and names) and
 * written by `recordAssignmentAudits` on the global pool. Writing it inside
 * the transaction deadlocks: `computer_audit_events.asset_id` references
 * `assets.id`, so the audit insert waits for an asset row this same
 * transaction has not committed yet.
 */
export type AssignmentAudit = {
  assignmentId: string;
  assetId: string;
  actorEmail: string;
  summary: string;
  details: Record<string, unknown>;
  /** Returns append a new row. Assigns keep the assignment id as `sourceId`. */
  append?: boolean;
};

/** Success from `assignAssetTx`, including an audit when a Computer changed hands. */
export type AssignTxResult =
  | { ok: true; audit?: AssignmentAudit }
  | { ok: false; error: AssignError };

/** Success from `returnAssetTx`. `audits` is omitted when there is nothing to record. */
export type ReturnTxResult = {
  ok: true;
  changed: boolean;
  audits?: AssignmentAudit[];
};

/** A transaction handle (same query surface as `db`), so the engine core can run
   inside a caller's transaction — the asset form assignee change shares the
   asset create/update transaction, keeping the log and `assigneeId` atomic. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A lost double-assign race: two assigns of the same device commit at once and
 * the second trips the `asset_assignments_open_uq` partial unique index (SQLSTATE
 * 23505), which is exactly the "at most one open assignment per device" guard
 * (AC-5, AC-11). The insert aborts its transaction, so the write rolls back; this
 * lets the callers turn that into a clean "try again" result instead of a raw
 * uncaught error. postgres.js exposes the SQLSTATE as `code` and the index as
 * `constraint_name`.
 */
const ASSIGNMENT_AUDIT_TABLE = "asset_assignments";

function assignmentSource(actorEmail: string): "admin_console" | "collector" {
  if (actorEmail === "collector" || actorEmail.startsWith("scan")) return "collector";
  return "admin_console";
}

function personLabel(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed || null;
}

function assignmentSummary(
  kind: "assign" | "return",
  fromName: string | null,
  toName: string | null,
  hadPrevious: boolean,
): string {
  if (kind === "return") {
    return fromName ? `Returned from ${fromName}` : "Returned device";
  }
  if (fromName && toName) return `Reassigned from ${fromName} to ${toName}`;
  if (hadPrevious && toName) return `Reassigned to ${toName}`;
  if (toName) return `Assigned to ${toName}`;
  return "Assignment changed";
}

async function auditAssignmentChange(input: AssignmentAudit): Promise<void> {
  await upsertAuditEvent({
    sourceTable: ASSIGNMENT_AUDIT_TABLE,
    sourceId: input.append ? randomUUID() : input.assignmentId,
    assetId: input.assetId,
    action: "assignment_change",
    operator: input.actorEmail,
    source: assignmentSource(input.actorEmail),
    summary: input.summary,
    details: input.append
      ? { ...input.details, assignmentId: input.assignmentId }
      : input.details,
    status: "succeeded",
  });
}

/** Write assignment audits. Call only after the custody transaction has committed. */
export async function recordAssignmentAudits(
  audits: readonly AssignmentAudit[],
): Promise<void> {
  for (const audit of audits) {
    await auditAssignmentChange(audit);
  }
}

/**
 * Audit Computer returns that were closed outside `returnAssetTx` (person
 * archive). `rows` are assignments that have already committed. Other asset
 * types are skipped.
 */
export async function recordComputerReturnAudits(
  rows: { assignmentId: string; assetId: string; personId: string }[],
  actorEmail: string,
): Promise<void> {
  const pending = rows.filter((row) => row.assignmentId && row.assetId);
  if (!pending.length) return;

  const typed = await db
    .select({ id: assets.id, type: assets.type })
    .from(assets)
    .where(
      inArray(
        assets.id,
        [...new Set(pending.map((row) => row.assetId))],
      ),
    );
  const computers = new Set(
    typed.filter((asset) => asset.type === "Computer").map((asset) => asset.id),
  );
  const computerRows = pending.filter((row) => computers.has(row.assetId));
  if (!computerRows.length) return;

  const holders = await db
    .select({ id: people.id, name: people.name })
    .from(people)
    .where(
      inArray(
        people.id,
        [...new Set(computerRows.map((row) => row.personId))],
      ),
    );
  const names = new Map(
    holders.map((holder) => [holder.id, personLabel(holder.name)]),
  );

  await recordAssignmentAudits(
    computerRows.map((row) => {
      const fromName = names.get(row.personId) ?? null;
      return {
        assignmentId: row.assignmentId,
        assetId: row.assetId,
        actorEmail,
        summary: assignmentSummary("return", fromName, null, true),
        details: { personId: row.personId, fromName },
        append: true,
      };
    }),
  );
}

export function isOpenAssignmentRace(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  return (
    e.code === "23505" &&
    String(e.constraint_name ?? "").includes("asset_assignments_open")
  );
}

/** Resolve an asset's human tag to its UUID, or null when no asset matches. */
export async function resolveAssetId(tag: string): Promise<string | null> {
  const [row] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.tag, tag))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Assign a device to a person (AC-5). In one transaction: close any assignment
 * open for the device, open a fresh one, and set `assets.assigneeId` to the
 * person. Reassigning to the same person who already holds it is a no-op (no
 * churn in the log). Rejects an archived person (AC-8: the picker offers active
 * people, this is the server-side backstop). A lost double-assign race becomes a
 * clean `already-assigned` result (the transaction rolled back).
 */
export async function assignAsset(
  assetId: string,
  personId: string,
  actorEmail: string,
  when: Date = new Date(),
): Promise<AssignResult> {
  try {
    const res = await db.transaction((tx) =>
      assignAssetTx(tx, assetId, personId, actorEmail, when),
    );
    if (res.ok && res.audit) await recordAssignmentAudits([res.audit]);
    return res.ok ? { ok: true } : res;
  } catch (err) {
    if (isOpenAssignmentRace(err)) return { ok: false, error: "already-assigned" };
    throw err;
  }
}

/** The assign core, run against a caller-provided transaction (AC-5, AC-11).
 *  Returns an audit payload for a Computer change and does not write it. */
export async function assignAssetTx(
  tx: Tx,
  assetId: string,
  personId: string,
  actorEmail: string,
  when: Date = new Date(),
): Promise<AssignTxResult> {
  if (!UUID_RE.test(assetId)) return { ok: false, error: "asset-not-found" };
  if (!UUID_RE.test(personId)) return { ok: false, error: "person-not-found" };

  const [asset] = await tx
    .select({ id: assets.id, type: assets.type })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!asset) return { ok: false, error: "asset-not-found" };

  const [person] = await tx
    .select({ id: people.id, status: people.status, name: people.name })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  if (!person) return { ok: false, error: "person-not-found" };
  if (person.status !== "active") {
    return { ok: false, error: "person-archived" };
  }

  const [open] = await tx
    .select({
      id: assetAssignments.id,
      personId: assetAssignments.personId,
      personName: people.name,
    })
    .from(assetAssignments)
    .innerJoin(people, eq(people.id, assetAssignments.personId))
    .where(
      and(
        eq(assetAssignments.assetId, assetId),
        isNull(assetAssignments.unassignedAt),
      ),
    )
    .limit(1);

  // Already held by this person → nothing to do (keeps the log clean).
  if (open && open.personId === personId) return { ok: true };

  if (open) {
    await tx
      .update(assetAssignments)
      .set({ unassignedAt: when, unassignedBy: actorEmail, updatedAt: when })
      .where(eq(assetAssignments.id, open.id));
  }

  const [created] = await tx
    .insert(assetAssignments)
    .values({
      assetId,
      personId,
      assignedAt: when,
      assignedBy: actorEmail,
    })
    .returning({ id: assetAssignments.id });

  await tx
    .update(assets)
    .set({ assigneeId: personId, updatedAt: when })
    .where(eq(assets.id, assetId));

  if (asset.type === "Computer" && created?.id) {
    const toName = personLabel(person.name);
    const fromName = personLabel(open?.personName);
    return {
      ok: true,
      audit: {
        assignmentId: created.id,
        assetId,
        actorEmail,
        summary: assignmentSummary("assign", fromName, toName, Boolean(open)),
        details: {
          fromPersonId: open?.personId ?? null,
          fromName,
          toPersonId: personId,
          toName,
        },
      },
    };
  }

  return { ok: true };
}

/**
 * Return (unassign) a device (AC-6). Closes its open assignment (recording who
 * and when) and clears `assets.assigneeId`, in one transaction. A no-op when the
 * device has no open assignment (`changed: false`); it still clears any stray
 * `assigneeId` so the invariant holds.
 */
export async function returnAsset(
  assetId: string,
  actorEmail: string,
  when: Date = new Date(),
): Promise<{ ok: true; changed: boolean }> {
  const res = await db.transaction((tx) =>
    returnAssetTx(tx, assetId, actorEmail, when),
  );
  if (res.audits?.length) await recordAssignmentAudits(res.audits);
  return { ok: true, changed: res.changed };
}

/** The return core, run against a caller-provided transaction (AC-6, AC-11).
 *  Returns audit payloads for Computer returns and does not write them. */
export async function returnAssetTx(
  tx: Tx,
  assetId: string,
  actorEmail: string,
  when: Date = new Date(),
): Promise<ReturnTxResult> {
  if (!UUID_RE.test(assetId)) return { ok: true, changed: false };

  const [asset] = await tx
    .select({ type: assets.type })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);

  const closed = await tx
    .update(assetAssignments)
    .set({ unassignedAt: when, unassignedBy: actorEmail, updatedAt: when })
    .where(
      and(
        eq(assetAssignments.assetId, assetId),
        isNull(assetAssignments.unassignedAt),
      ),
    )
    .returning({ id: assetAssignments.id, personId: assetAssignments.personId });

  await tx
    .update(assets)
    .set({ assigneeId: null, updatedAt: when })
    .where(eq(assets.id, assetId));

  const audits: AssignmentAudit[] = [];
  if (asset?.type === "Computer") {
    for (const row of closed) {
      const [holder] = await tx
        .select({ name: people.name })
        .from(people)
        .where(eq(people.id, row.personId))
        .limit(1);
      const fromName = personLabel(holder?.name);
      audits.push({
        assignmentId: row.id,
        assetId,
        actorEmail,
        summary: assignmentSummary("return", fromName, null, true),
        details: { personId: row.personId, fromName },
        append: true,
      });
    }
  }

  return audits.length
    ? { ok: true, changed: true, audits }
    : { ok: true, changed: closed.length > 0 };
}

/* ---------------- Read paths (AC-4, AC-7) ---------------- */

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.toISOString();
}

type EventRow = {
  id: string;
  assetTag: string;
  assetName: string;
  assetType: string;
  personId: string;
  personName: string;
  assignedAt: Date | string;
  assignedBy: string;
  unassignedAt: Date | string | null;
  unassignedBy: string | null;
};

function toEvent(r: EventRow): AssignmentEvent {
  return {
    id: r.id,
    assetId: r.assetTag,
    assetName: r.assetName,
    assetType: r.assetType as AssetType,
    personId: r.personId,
    personName: r.personName,
    assignedAt: iso(r.assignedAt) ?? "",
    assignedBy: r.assignedBy,
    unassignedAt: iso(r.unassignedAt),
    unassignedBy: r.unassignedBy,
    open: r.unassignedAt == null,
  };
}

const eventSelect = {
  id: assetAssignments.id,
  assetTag: assets.tag,
  assetName: assets.name,
  assetType: assets.type,
  personId: assetAssignments.personId,
  personName: people.name,
  assignedAt: assetAssignments.assignedAt,
  assignedBy: assetAssignments.assignedBy,
  unassignedAt: assetAssignments.unassignedAt,
  unassignedBy: assetAssignments.unassignedBy,
};

/**
 * The custody history of one device, newest first (AC-7). `tag` is the asset's
 * human id. Empty when the asset has no history (or no such asset).
 */
export async function getAssetAssignmentHistory(
  tag: string,
): Promise<AssignmentEvent[]> {
  const rows = await db
    .select(eventSelect)
    .from(assetAssignments)
    .innerJoin(assets, eq(assets.id, assetAssignments.assetId))
    .innerJoin(people, eq(people.id, assetAssignments.personId))
    .where(eq(assets.tag, tag))
    .orderBy(desc(assetAssignments.assignedAt));
  return rows.map(toEvent);
}

/**
 * A person's current devices plus their full assignment history (AC-4). Current
 * devices are the open assignments; history is every assignment (open + closed),
 * newest first.
 */
export async function getPersonAssignments(personId: string): Promise<{
  currentDevices: CurrentDevice[];
  history: AssignmentEvent[];
}> {
  if (!UUID_RE.test(personId)) return { currentDevices: [], history: [] };

  const rows = await db
    .select({ ...eventSelect, assetSerial: assets.serial })
    .from(assetAssignments)
    .innerJoin(assets, eq(assets.id, assetAssignments.assetId))
    .innerJoin(people, eq(people.id, assetAssignments.personId))
    .where(eq(assetAssignments.personId, personId))
    .orderBy(desc(assetAssignments.assignedAt));

  const history = rows.map(toEvent);
  const currentDevices: CurrentDevice[] = rows
    .filter((r) => r.unassignedAt == null)
    .map((r) => ({
      id: r.assetTag,
      name: r.assetName,
      type: r.assetType as AssetType,
      serial: r.assetSerial ?? "",
      assignedAt: iso(r.assignedAt) ?? "",
    }));

  return { currentDevices, history };
}
