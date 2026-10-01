import "server-only";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
  sum,
} from "drizzle-orm";

import { db } from "@/db/index";
import { assets, media } from "@/db/schema";
import type { AssetRow, MediaRow } from "@/db/schema";
import {
  type AllowedImageType,
  newMediaObjectKey,
  newMediaThumbKey,
  putImage,
  removeImage,
  sha256Hex,
} from "@/lib/storage";
import { processImage } from "@/lib/image";

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
  const thumbnailKey = newMediaThumbKey(id);

  // Cap the original, read its real dimensions, and build a thumbnail (phase 2).
  // The hash above was taken on the uploaded bytes, so dedup is unaffected.
  const processed = await processImage(input.bytes, input.contentType);

  // Store the objects before the row, so a failed store never leaves a row pointing
  // at missing bytes. If the row insert then loses the dedup race, we remove them.
  await putImage(objectKey, processed.original, input.contentType);
  await putImage(thumbnailKey, processed.thumbnail, "image/webp");

  try {
    const [row] = await db
      .insert(media)
      .values({
        id,
        name: input.name,
        objectKey,
        thumbnailKey,
        contentType: input.contentType,
        sizeBytes: processed.original.byteLength,
        width: processed.width,
        height: processed.height,
        sha256: sha,
        createdBy: input.createdBy,
      })
      .returning();
    return row;
  } catch (err) {
    if (isMediaDedupRace(err)) {
      // Someone else inserted the same content between our lookup and insert.
      // Drop the objects we just wrote (the winner has its own) and return theirs.
      await removeImage(objectKey);
      await removeImage(thumbnailKey);
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

/** Library-wide totals for the dashboard stat cards (spec 18 UI). */
export type MediaStats = {
  totalImages: number;
  assetsUsingImages: number;
  totalSizeBytes: number;
};

export async function getMediaStats(): Promise<MediaStats> {
  const [imgs] = await db
    .select({ n: count(), size: sum(media.sizeBytes) })
    .from(media);
  const [used] = await db
    .select({ n: count() })
    .from(assets)
    .where(isNotNull(assets.imageId));
  return {
    totalImages: Number(imgs?.n ?? 0),
    assetsUsingImages: Number(used?.n ?? 0),
    totalSizeBytes: Number(imgs?.size ?? 0),
  };
}

const PAGE = 48;

/** Asset-type value (the `asset_type` enum), used by the library type filter. */
type AssetTypeValue = AssetRow["type"];

export type MediaSort = "recent" | "most-used";

export type MediaListPage = {
  items: MediaWithUsage[];
  /** Offset to pass for the next page, or null when there are no more. */
  nextOffset: number | null;
};

/**
 * The library listing (AC-5): images with their usage count, filtered/sorted for
 * the dashboard. Optional case-insensitive name/notes search, an asset-type filter
 * (media used by at least one asset of that type), a sort ("recent" default, or
 * "most-used" by usage count), and offset pagination. Usage is counted in-query via
 * a left join + groupBy, so "most used" can order by it.
 */
export async function listMedia(opts?: {
  q?: string;
  type?: AssetTypeValue;
  sort?: MediaSort;
  limit?: number;
  offset?: number;
}): Promise<MediaListPage> {
  const limit = Math.min(Math.max(opts?.limit ?? PAGE, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const q = opts?.q?.trim();
  const sort = opts?.sort ?? "recent";

  const conds = [];
  if (q) {
    const like = `%${q}%`;
    conds.push(or(ilike(media.name, like), ilike(media.notes, like)));
  }
  if (opts?.type) {
    // Keep only media referenced by at least one asset of the given type.
    conds.push(
      inArray(
        media.id,
        db
          .selectDistinct({ id: assets.imageId })
          .from(assets)
          .where(and(isNotNull(assets.imageId), eq(assets.type, opts.type))),
      ),
    );
  }

  const usedBy = count(assets.id);
  const rows = await db
    .select({ media, usedBy })
    .from(media)
    .leftJoin(assets, eq(assets.imageId, media.id))
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(media.id)
    .orderBy(
      ...(sort === "most-used"
        ? [desc(usedBy), asc(media.name)]
        : [desc(media.createdAt), desc(media.id)]),
    )
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items: MediaWithUsage[] = pageRows.map((r) => ({
    ...r.media,
    usedBy: Number(r.usedBy),
  }));
  const nextOffset = hasMore ? offset + limit : null;
  return { items, nextOffset };
}

/** One asset that uses a media row, for the detail page's "Used in Assets" list. */
export type MediaAssetUse = { tag: string; name: string; type: AssetTypeValue };

/** A media row plus its usage count and the assets using it (the detail page). */
export type MediaDetail = MediaRow & { usedBy: number; assets: MediaAssetUse[] };

export async function getMediaDetail(id: string): Promise<MediaDetail | null> {
  const row = await getMedia(id);
  if (!row) return null;
  const used = await db
    .select({ tag: assets.tag, name: assets.name, type: assets.type })
    .from(assets)
    .where(eq(assets.imageId, id))
    .orderBy(asc(assets.name));
  return { ...row, usedBy: used.length, assets: used };
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
