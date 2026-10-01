import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "@/db/index";
import { assets, media } from "@/db/schema";
import type { MediaRow } from "@/db/schema";
import {
  type AllowedImageType,
  newMediaObjectKey,
  putImage,
  removeImage,
  sha256Hex,
} from "@/lib/storage";

/**
 * The shared media library data layer (spec 18, phase 1). The single owner of the
 * `media` table and the only writer that stores or deletes a library object. Three
 * concurrency/cleanup rules the acceptance criteria depend on live here:
 *   (a) dedup race  — two identical uploads race on the partial-unique `sha256`
 *       insert; the loser's just-written object is removed and the winning row is
 *       returned, so AC-3 holds under concurrency.
 *   (b) delete removes bytes — deleting a row deletes its stored objects too, so
 *       no orphaned bytes leak.
 *   (c) delete race — a concurrent assign slips in after the "used by 0" check, so
 *       the `restrict` FK raises 23503; that becomes a clean "in use" result, never
 *       a 500.
 * "Used by N" is counted at read time (assets whose `imageId` = a media id), never
 * stored, so it can never go stale.
 */

/** A media row plus its read-time usage count (assets pointing at it). */
export type MediaWithUsage = MediaRow & { usedBy: number };

/**
 * A lost dedup race: two uploads of identical bytes both miss the hash lookup and
 * race on the `media_sha256_uq` partial unique index (SQLSTATE 23505). The loser's
 * insert aborts; this lets `createOrReuseMedia` clean up its object and return the
 * winning row instead of throwing (AC-3). Mirrors `isOpenAssignmentRace`.
 */
export function isMediaDedupRace(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  return (
    e.code === "23505" && String(e.constraint_name ?? "").includes("media_sha256")
  );
}

/**
 * A delete that races a concurrent assign: the `assets.image_id` → `media.id`
 * foreign key (`onDelete: restrict`) raises SQLSTATE 23503 when a row an asset now
 * references is deleted. Turned into the clean "in use" result (a 409), never a 500.
 */
export function isMediaInUseViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === "23503";
}

/** Find a media row by its content hash, or null. */
async function findBySha(sha: string): Promise<MediaRow | null> {
  const [row] = await db
    .select()
    .from(media)
    .where(eq(media.sha256, sha))
    .limit(1);
  return row ?? null;
}

/**
 * Create a media row from uploaded bytes, or reuse the existing row when the exact
 * content already lives in the library (AC-3). The bytes are stored once: an
 * identical upload — even two racing at the same instant — yields exactly one
 * object and one row. The caller has already validated type and size.
 */
export async function createOrReuseMedia(input: {
  bytes: Buffer;
  contentType: AllowedImageType;
  name: string;
  createdBy: string | null;
}): Promise<MediaRow> {
  const sha = sha256Hex(input.bytes);

  // Fast path: the content is already in the library.
  const existing = await findBySha(sha);
  if (existing) return existing;

  const id = randomUUID();
  const objectKey = newMediaObjectKey(id, input.contentType);
  // Store the object before the row, so a failed store never leaves a row pointing
  // at missing bytes. If the row insert then loses the dedup race, we remove this.
  await putImage(objectKey, input.bytes, input.contentType);

  try {
    const [row] = await db
      .insert(media)
      .values({
        id,
        name: input.name,
        objectKey,
        contentType: input.contentType,
        sizeBytes: input.bytes.byteLength,
        sha256: sha,
        createdBy: input.createdBy,
      })
      .returning();
    return row;
  } catch (err) {
    if (isMediaDedupRace(err)) {
      // Someone else inserted the same content between our lookup and insert.
      // Drop the object we just wrote (the winner has its own) and return theirs.
      await removeImage(objectKey);
      const winner = await findBySha(sha);
      if (winner) return winner;
    }
    throw err;
  }
}

/** One media row by id, or null. */
export async function getMedia(id: string): Promise<MediaRow | null> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  return row ?? null;
}

/** How many assets currently use a media row. */
export async function getMediaUsageCount(id: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assets)
    .where(eq(assets.imageId, id));
  return row?.n ?? 0;
}

/** Usage counts for several media ids in one grouped query → {mediaId: count}. */
async function countUsage(ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ imageId: assets.imageId, n: sql<number>`count(*)::int` })
    .from(assets)
    .where(inArray(assets.imageId, ids))
    .groupBy(assets.imageId);
  for (const r of rows) if (r.imageId) map.set(r.imageId, Number(r.n));
  return map;
}

const PAGE = 60;

export type MediaListPage = {
  items: MediaWithUsage[];
  nextCursor: string | null;
};

/** Decode / encode an opaque keyset cursor of `${createdAtISO}|${id}`. */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString(
    "base64url",
  );
}
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url")
      .toString("utf8")
      .split("|");
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * The library listing (AC-5): every image, newest first, with its usage count.
 * Optional case-insensitive name/notes search and keyset pagination.
 */
export async function listMedia(opts?: {
  q?: string;
  cursor?: string;
  limit?: number;
}): Promise<MediaListPage> {
  const limit = Math.min(Math.max(opts?.limit ?? PAGE, 1), 200);
  const q = opts?.q?.trim();
  const cur = opts?.cursor ? decodeCursor(opts.cursor) : null;

  const conds = [];
  if (q) {
    const like = `%${q}%`;
    conds.push(or(ilike(media.name, like), ilike(media.notes, like)));
  }
  if (cur) {
    // Keyset: strictly "older than" the cursor row in (createdAt, id) order.
    conds.push(
      or(
        lt(media.createdAt, cur.createdAt),
        and(eq(media.createdAt, cur.createdAt), lt(media.id, cur.id)),
      ),
    );
  }

  const rows = await db
    .select()
    .from(media)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Usage counts in one grouped query over just this page's ids. (A correlated
  // count subquery inside the select renders wrong in Drizzle and reads 0; a
  // groupBy aggregate is the reliable pattern.)
  const usage = await countUsage(pageRows.map((r) => r.id));
  const items: MediaWithUsage[] = pageRows.map((r) => ({
    ...r,
    usedBy: usage.get(r.id) ?? 0,
  }));
  const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
  return { items, nextCursor };
}

export type UpdateMediaResult =
  | { ok: true; row: MediaRow }
  | { ok: false; error: "not-found" };

/** Edit a media row's metadata (AC-5): name, alt text, notes. */
export async function updateMediaMeta(
  id: string,
  fields: { name?: string; altText?: string | null; notes?: string | null },
): Promise<UpdateMediaResult> {
  const patch: Partial<{
    name: string;
    altText: string | null;
    notes: string | null;
    updatedAt: Date;
  }> = { updatedAt: new Date() };
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.altText !== undefined) patch.altText = fields.altText;
  if (fields.notes !== undefined) patch.notes = fields.notes;

  const [row] = await db
    .update(media)
    .set(patch)
    .where(eq(media.id, id))
    .returning();
  if (!row) return { ok: false, error: "not-found" };
  return { ok: true, row };
}

export type DeleteMediaResult =
  | { ok: true }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "in-use"; usedBy: number };

/**
 * Delete a library image, blocked while any asset still uses it (AC-6). On
 * success the stored objects are removed too, so no orphaned bytes leak (rule b).
 * A concurrent assign that slips in after the usage check trips the `restrict` FK
 * (23503), which becomes the same clean "in use" result (rule c).
 */
export async function deleteMedia(id: string): Promise<DeleteMediaResult> {
  const row = await getMedia(id);
  if (!row) return { ok: false, error: "not-found" };

  const usedBy = await getMediaUsageCount(id);
  if (usedBy > 0) return { ok: false, error: "in-use", usedBy };

  try {
    const deleted = await db
      .delete(media)
      .where(eq(media.id, id))
      .returning({ id: media.id });
    if (deleted.length === 0) return { ok: false, error: "not-found" };
  } catch (err) {
    if (isMediaInUseViolation(err)) {
      // An assign raced in after our count; recount for an accurate message.
      return { ok: false, error: "in-use", usedBy: await getMediaUsageCount(id) };
    }
    throw err;
  }

  // Row is gone → remove its bytes (best effort; a missing object is ignored).
  await removeImage(row.objectKey);
  if (row.thumbnailKey) await removeImage(row.thumbnailKey);

  return { ok: true };
}
