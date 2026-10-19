import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "./index";
import { scripts, type ScriptRow } from "./schema";

/** Script library catalog (spec 32). */

export const SCRIPT_BODY_MAX = 64 * 1024;
export const SCRIPT_TIMEOUT_DEFAULT = 120;
export const SCRIPT_TIMEOUT_MAX = 600;

export type ScriptListItem = {
  id: string;
  name: string;
  description: string | null;
  body: string;
  timeoutSeconds: number;
  bodyLength: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

function clampTimeout(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return SCRIPT_TIMEOUT_DEFAULT;
  return Math.min(SCRIPT_TIMEOUT_MAX, Math.max(30, Math.trunc(n)));
}

export async function listScripts(): Promise<ScriptListItem[]> {
  const rows = await db
    .select()
    .from(scripts)
    .where(isNull(scripts.archivedAt))
    .orderBy(asc(scripts.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    body: r.body,
    timeoutSeconds: r.timeoutSeconds,
    bodyLength: r.body.length,
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function getScript(id: string): Promise<ScriptRow | null> {
  const [row] = await db.select().from(scripts).where(eq(scripts.id, id)).limit(1);
  return row ?? null;
}

export type UpsertScriptInput = {
  name: string;
  description?: string | null;
  body: string;
  timeoutSeconds?: number | null;
  actorEmail: string;
};

export type UpsertResult =
  | { ok: true; id: string }
  | { ok: false; reason: "empty-name" | "empty-body" | "body-too-large" };

export async function createScript(input: UpsertScriptInput): Promise<UpsertResult> {
  const name = input.name.trim();
  const body = input.body;
  if (!name) return { ok: false, reason: "empty-name" };
  if (!body.trim()) return { ok: false, reason: "empty-body" };
  if (body.length > SCRIPT_BODY_MAX) return { ok: false, reason: "body-too-large" };

  const [row] = await db
    .insert(scripts)
    .values({
      name,
      description: input.description?.trim() || null,
      body,
      timeoutSeconds: clampTimeout(input.timeoutSeconds ?? undefined),
      createdBy: input.actorEmail,
      updatedBy: input.actorEmail,
    })
    .returning({ id: scripts.id });
  return { ok: true, id: row.id };
}

export async function updateScript(
  id: string,
  input: UpsertScriptInput,
): Promise<UpsertResult | { ok: false; reason: "notfound" }> {
  const name = input.name.trim();
  const body = input.body;
  if (!name) return { ok: false, reason: "empty-name" };
  if (!body.trim()) return { ok: false, reason: "empty-body" };
  if (body.length > SCRIPT_BODY_MAX) return { ok: false, reason: "body-too-large" };

  const updated = await db
    .update(scripts)
    .set({
      name,
      description: input.description?.trim() || null,
      body,
      timeoutSeconds: clampTimeout(input.timeoutSeconds ?? undefined),
      updatedBy: input.actorEmail,
      updatedAt: new Date(),
    })
    .where(and(eq(scripts.id, id), isNull(scripts.archivedAt)))
    .returning({ id: scripts.id });
  if (!updated.length) return { ok: false, reason: "notfound" };
  return { ok: true, id: updated[0].id };
}

export async function archiveScript(id: string): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(scripts)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(scripts.id, id), isNull(scripts.archivedAt)))
    .returning({ id: scripts.id });
  return updated.length > 0;
}
