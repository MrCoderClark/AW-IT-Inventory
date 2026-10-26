import "server-only";

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { AuditAction, AuditSource, AuditStatus } from "@/lib/computer-audit-actions";

import { db } from "./index";
import { getSubtreeIds } from "./queries";
import { assets, computerAuditEvents } from "./schema";

/**
 * Computer audit log (spec 26). Dual-write helpers upsert on enqueue and update
 * on terminal. Read helpers feed `/audit` and share its default 30-day window.
 * Write failures are logged and never thrown.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type UpsertAuditEventInput = {
  sourceTable: string;
  sourceId: string;
  assetId: string;
  action: AuditAction;
  operator: string;
  source: AuditSource;
  summary: string;
  details?: Record<string, unknown>;
  status?: AuditStatus;
  occurredAt?: Date;
};

export type UpdateAuditEventStatusInput = {
  sourceTable: string;
  sourceId: string;
  status: AuditStatus;
  summary?: string;
  details?: Record<string, unknown>;
};

export type AuditListItem = {
  id: string;
  occurredAtIso: string;
  assetTag: string;
  assetName: string;
  serial: string | null;
  action: string;
  status: string;
  operator: string;
  source: string;
  summary: string;
  flagged: boolean;
  details: Record<string, unknown>;
};

export type AuditListFilters = {
  assetId?: string;
  action?: string;
  operator?: string;
  locationId?: string;
  from?: Date;
  to?: Date;
  flagged?: boolean;
  limit?: number;
  offset?: number;
};

/** Time and location slice shared by the audit page KPIs. */
export type AuditKpiFilters = Pick<AuditListFilters, "from" | "to" | "locationId">;

export type AuditKpis = {
  total: number;
  today: number;
  uniqueOperators: number;
  flagged: number;
};

const listColumns = {
  id: computerAuditEvents.id,
  occurredAt: computerAuditEvents.occurredAt,
  assetTag: assets.tag,
  assetName: assets.name,
  serial: assets.serial,
  action: computerAuditEvents.action,
  status: computerAuditEvents.status,
  operator: computerAuditEvents.operator,
  source: computerAuditEvents.source,
  summary: computerAuditEvents.summary,
  flagged: computerAuditEvents.flagged,
  details: computerAuditEvents.details,
};

function defaultFrom(from: Date | undefined): Date {
  return from ?? new Date(Date.now() - THIRTY_DAYS_MS);
}

/** Midnight UTC of the current day. "Actions today" uses this bound. */
function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function logAuditError(err: unknown) {
  console.error("[audit]", err);
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type ListRow = {
  id: string;
  occurredAt: Date | string;
  assetTag: string;
  assetName: string;
  serial: string | null;
  action: string;
  status: string;
  operator: string;
  source: string;
  summary: string;
  flagged: boolean;
  details: Record<string, unknown> | null;
};

function toListItem(row: ListRow): AuditListItem {
  return {
    id: row.id,
    occurredAtIso: toIso(row.occurredAt),
    assetTag: row.assetTag,
    assetName: row.assetName,
    serial: row.serial,
    action: row.action,
    status: row.status,
    operator: row.operator,
    source: row.source,
    summary: row.summary,
    flagged: row.flagged,
    details: row.details ?? {},
  };
}

type Pageable<T> = PromiseLike<T> & {
  limit: (n: number) => PromiseLike<T> & {
    offset: (n: number) => PromiseLike<T>;
  };
  offset: (n: number) => PromiseLike<T>;
};

async function page<T>(
  query: Pageable<T>,
  filters: { limit?: number; offset?: number },
): Promise<T> {
  if (filters.limit != null && filters.offset != null) {
    return await query.limit(filters.limit).offset(filters.offset);
  }
  if (filters.limit != null) return await query.limit(filters.limit);
  if (filters.offset != null) return await query.offset(filters.offset);
  return await query;
}

/**
 * Insert an audit row, or refresh the existing row for `(sourceTable, sourceId)`.
 * `occurredAt` is written only on insert; a conflict keeps the first timestamp.
 * Omitted `status` / `details` default on insert (`pending`, `{}`) and are left
 * as stored on conflict. `flagged` is left untouched. Errors return `{ ok: false }`
 * and are logged.
 */
export async function upsertAuditEvent(
  input: UpsertAuditEventInput,
): Promise<{ ok: true; id: string } | { ok: false }> {
  const now = new Date();
  try {
    const [row] = await db
      .insert(computerAuditEvents)
      .values({
        sourceTable: input.sourceTable,
        sourceId: input.sourceId,
        assetId: input.assetId,
        action: input.action,
        operator: input.operator,
        source: input.source,
        summary: input.summary,
        details: input.details ?? {},
        status: input.status ?? "pending",
        updatedAt: now,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      })
      .onConflictDoUpdate({
        target: [computerAuditEvents.sourceTable, computerAuditEvents.sourceId],
        set: {
          assetId: input.assetId,
          action: input.action,
          operator: input.operator,
          source: input.source,
          summary: input.summary,
          updatedAt: now,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.details !== undefined ? { details: input.details } : {}),
        },
      })
      .returning({ id: computerAuditEvents.id });
    if (!row?.id) return { ok: false };
    return { ok: true, id: row.id };
  } catch (err) {
    logAuditError(err);
    return { ok: false };
  }
}

/**
 * Terminal-status update for an existing audit row. Missing summary/details
 * are left as stored. Returns false when no row matches or the write fails.
 */
export async function updateAuditEventStatus(
  input: UpdateAuditEventStatusInput,
): Promise<boolean> {
  try {
    const patch: {
      status: AuditStatus;
      updatedAt: Date;
      summary?: string;
      details?: Record<string, unknown>;
    } = {
      status: input.status,
      updatedAt: new Date(),
    };
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.details !== undefined) patch.details = input.details;

    const rows = await db
      .update(computerAuditEvents)
      .set(patch)
      .where(
        and(
          eq(computerAuditEvents.sourceTable, input.sourceTable),
          eq(computerAuditEvents.sourceId, input.sourceId),
        ),
      )
      .returning({ id: computerAuditEvents.id });
    return rows.length > 0;
  } catch (err) {
    logAuditError(err);
    return false;
  }
}

function eventWhere(filters: AuditListFilters, from: Date) {
  return and(
    gte(computerAuditEvents.occurredAt, from),
    filters.to ? lte(computerAuditEvents.occurredAt, filters.to) : undefined,
    filters.assetId ? eq(computerAuditEvents.assetId, filters.assetId) : undefined,
    filters.action ? eq(computerAuditEvents.action, filters.action) : undefined,
    filters.operator ? eq(computerAuditEvents.operator, filters.operator) : undefined,
    filters.flagged === undefined
      ? undefined
      : eq(computerAuditEvents.flagged, filters.flagged),
  );
}

/** Location ids in the filter subtree, or null when the list is unfiltered.
 *  [] means the location does not exist, so the caller matches nothing. */
async function locationSubtree(locationId: string | undefined): Promise<string[] | null> {
  if (!locationId) return null;
  return getSubtreeIds(locationId);
}

/**
 * Audit rows for the page, newest first. Joins `assets` for tag/name/serial.
 * When `locationId` is set, keeps events whose asset sits in that location or
 * any descendant (same subtree rule as the asset lists). Omitted `from` means
 * the last 30 days.
 */
export async function listAuditEvents(
  filters: AuditListFilters = {},
): Promise<AuditListItem[]> {
  const subtree = await locationSubtree(filters.locationId);
  if (subtree && subtree.length === 0) return [];

  const from = defaultFrom(filters.from);
  const where = and(
    eventWhere(filters, from),
    subtree ? inArray(assets.locationId, subtree) : undefined,
  );
  const ordered = db
    .select(listColumns)
    .from(computerAuditEvents)
    .innerJoin(assets, eq(computerAuditEvents.assetId, assets.id))
    .where(where)
    .orderBy(desc(computerAuditEvents.occurredAt));

  const rows = await page(ordered, filters);
  return rows.map(toListItem);
}

/**
 * KPI strip for the same time/location window as the list. `today` counts
 * events in that window with `occurredAt` on or after UTC midnight.
 */
export async function getAuditKpis(filters: AuditKpiFilters = {}): Promise<AuditKpis> {
  const subtree = await locationSubtree(filters.locationId);
  if (subtree && subtree.length === 0) {
    return { total: 0, today: 0, uniqueOperators: 0, flagged: 0 };
  }

  const from = defaultFrom(filters.from);
  // Bind as ISO text — embedding a Date in FILTER (WHERE …) can stringify as a
  // locale string and blow up the driver (e.g. "Sun Oct 25 2026 20:00:00 GMT-0400").
  const dayIso = startOfUtcDay().toISOString();
  const selection = {
    total: sql<number>`count(*)::int`,
    today: sql<number>`coalesce(sum(case when ${computerAuditEvents.occurredAt} >= ${dayIso}::timestamptz then 1 else 0 end), 0)::int`,
    uniqueOperators: sql<number>`count(distinct ${computerAuditEvents.operator})::int`,
    flagged: sql<number>`coalesce(sum(case when ${computerAuditEvents.flagged} then 1 else 0 end), 0)::int`,
  };
  const timeWhere = and(
    gte(computerAuditEvents.occurredAt, from),
    filters.to ? lte(computerAuditEvents.occurredAt, filters.to) : undefined,
    subtree ? inArray(assets.locationId, subtree) : undefined,
  );
  const rows = await db
    .select(selection)
    .from(computerAuditEvents)
    .innerJoin(assets, eq(computerAuditEvents.assetId, assets.id))
    .where(timeWhere);

  const row = rows[0];
  return {
    total: num(row?.total),
    today: num(row?.today),
    uniqueOperators: num(row?.uniqueOperators),
    flagged: num(row?.flagged),
  };
}
