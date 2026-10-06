import "server-only";

import { desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "./index";
import { assets, people } from "./schema";
import { getLocationPathMap } from "./queries";
import type { AssetStatus, AssetType } from "@/lib/data";

/* ================================================================
   Reports (backlog "Reports page"). Read-only analytics over the
   assets we already hold — no new tables, no collector work. Each
   report is a plain aggregate the /reports page renders as summary
   tiles plus a focused table. All server-only; gated at the page on
   `asset:read`. The fleet is ~hundreds of rows, so where bucketing
   needs date math we fetch the slim column set and bucket in JS
   (today's calendar day is the reference), which keeps the rules in
   one readable place rather than spread across SQL date functions.
   ================================================================ */

/** Whole days from today (UTC calendar day) to a `YYYY-MM-DD` date string.
   Negative = in the past. Null/blank dates return null (unknown). */
function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const target = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.round((target - todayUtc) / 86_400_000);
}

/* ---------------- Warranty expiry ---------------- */

export type WarrantyBucket = "expired" | "soon" | "upcoming" | "ok";

/** One device on the warranty report. `daysLeft` is relative to today
   (negative = already expired). */
export interface WarrantyReportRow {
  tag: string;
  name: string;
  type: AssetType;
  vendor: string | null;
  warrantyUntil: string; // YYYY-MM-DD
  daysLeft: number;
  bucket: WarrantyBucket;
  status: AssetStatus;
  assignee: string | null;
  location: string;
}

export interface WarrantyReport {
  rows: WarrantyReportRow[]; // soonest-expiring first, only expired + ≤90 days
  counts: {
    expired: number;
    soon: number; // ≤ 30 days
    upcoming: number; // 31–90 days
    ok: number; // > 90 days
    unknown: number; // no warranty date on record
  };
  total: number;
}

const SOON_DAYS = 30;
const UPCOMING_DAYS = 90;

function warrantyBucket(daysLeft: number): WarrantyBucket {
  if (daysLeft < 0) return "expired";
  if (daysLeft <= SOON_DAYS) return "soon";
  if (daysLeft <= UPCOMING_DAYS) return "upcoming";
  return "ok";
}

/** Assets by warranty status: how many are expired / expiring soon, plus the
   action list (every expired or ≤90-day device, soonest first). */
export async function getWarrantyReport(): Promise<WarrantyReport> {
  const [rows, locationPaths] = await Promise.all([
    db
      .select({
        tag: assets.tag,
        name: assets.name,
        type: assets.type,
        vendor: assets.vendor,
        warrantyUntil: assets.warrantyUntil,
        status: assets.status,
        locationId: assets.locationId,
        assignee: people.name,
      })
      .from(assets)
      .leftJoin(people, eq(assets.assigneeId, people.id)),
    getLocationPathMap(),
  ]);

  const counts = { expired: 0, soon: 0, upcoming: 0, ok: 0, unknown: 0 };
  const actionRows: WarrantyReportRow[] = [];

  for (const r of rows) {
    const daysLeft = daysUntil(r.warrantyUntil);
    if (daysLeft === null) {
      counts.unknown += 1;
      continue;
    }
    const bucket = warrantyBucket(daysLeft);
    counts[bucket] += 1;
    if (bucket !== "ok") {
      actionRows.push({
        tag: r.tag,
        name: r.name,
        type: r.type,
        vendor: r.vendor,
        warrantyUntil: (r.warrantyUntil ?? "").slice(0, 10),
        daysLeft,
        bucket,
        status: r.status,
        assignee: r.assignee,
        location: (r.locationId && locationPaths.get(r.locationId)) || "",
      });
    }
  }

  actionRows.sort((a, b) => a.daysLeft - b.daysLeft);

  return { rows: actionRows, counts, total: rows.length };
}

/* ---------------- Asset aging ---------------- */

export type AgeBand = "under1" | "y1to3" | "y3to5" | "over5";

/** One device on the aging report, oldest first. `ageYears` is whole years
   since purchase. */
export interface AgingReportRow {
  tag: string;
  name: string;
  type: AssetType;
  vendor: string | null;
  purchaseDate: string; // YYYY-MM-DD
  ageYears: number;
  status: AssetStatus;
  location: string;
}

export interface AgingReport {
  oldest: AgingReportRow[]; // the oldest devices (refresh candidates), capped
  counts: {
    under1: number;
    y1to3: number;
    y3to5: number;
    over5: number;
    unknown: number; // no purchase date on record
  };
  total: number;
}

const OLDEST_LIMIT = 15;
const YEAR_DAYS = 365.25;

function ageBand(ageYears: number): AgeBand {
  if (ageYears < 1) return "under1";
  if (ageYears < 3) return "y1to3";
  if (ageYears < 5) return "y3to5";
  return "over5";
}

/** Assets bucketed by age since purchase, plus the oldest few as refresh
   candidates. Devices without a purchase date are counted as "unknown". */
export async function getAgingReport(): Promise<AgingReport> {
  const [rows, locationPaths] = await Promise.all([
    db
      .select({
        tag: assets.tag,
        name: assets.name,
        type: assets.type,
        vendor: assets.vendor,
        purchaseDate: assets.purchaseDate,
        status: assets.status,
        locationId: assets.locationId,
      })
      .from(assets),
    getLocationPathMap(),
  ]);

  const counts = { under1: 0, y1to3: 0, y3to5: 0, over5: 0, unknown: 0 };
  const dated: AgingReportRow[] = [];

  for (const r of rows) {
    const daysOld = daysUntil(r.purchaseDate);
    if (daysOld === null) {
      counts.unknown += 1;
      continue;
    }
    // A future-dated purchase (data entry slip) reads as age 0, band under1.
    const age = Math.max(0, -daysOld / YEAR_DAYS);
    const ageYears = Math.floor(age);
    counts[ageBand(age)] += 1;
    dated.push({
      tag: r.tag,
      name: r.name,
      type: r.type,
      vendor: r.vendor,
      purchaseDate: (r.purchaseDate ?? "").slice(0, 10),
      ageYears,
      status: r.status,
      location: (r.locationId && locationPaths.get(r.locationId)) || "",
    });
  }

  dated.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));

  return { oldest: dated.slice(0, OLDEST_LIMIT), counts, total: rows.length };
}

/* ---------------- Assignment summary ---------------- */

export interface AssignmentTypeRow {
  type: AssetType;
  total: number;
  assigned: number;
  unassigned: number;
}

/** A person holding the most devices, for the "top holders" table. */
export interface AssignmentHolderRow {
  id: string;
  name: string;
  department: string | null;
  jobTitle: string | null;
  deviceCount: number;
}

export interface AssignmentSummary {
  total: number;
  assigned: number;
  unassigned: number;
  peopleWithDevices: number;
  byType: AssignmentTypeRow[];
  topHolders: AssignmentHolderRow[];
}

const TOP_HOLDERS_LIMIT = 10;
const ASSET_TYPE_ORDER: AssetType[] = [
  "Computer",
  "Monitor",
  "Printer",
  "Phone",
  "Network",
];

/** Who holds what: assigned vs. pooled devices overall and per type, plus the
   people holding the most devices. */
export async function getAssignmentSummary(): Promise<AssignmentSummary> {
  const assignedExpr = sql<number>`count(*) filter (where ${assets.assigneeId} is not null)::int`;
  const [typeRows, holderRows] = await Promise.all([
    db
      .select({
        type: assets.type,
        total: sql<number>`count(*)::int`,
        assigned: assignedExpr,
      })
      .from(assets)
      .groupBy(assets.type),
    db
      .select({
        id: people.id,
        name: people.name,
        department: people.department,
        jobTitle: people.jobTitle,
        deviceCount: sql<number>`count(${assets.id})::int`,
      })
      .from(people)
      .innerJoin(assets, eq(assets.assigneeId, people.id))
      .groupBy(people.id, people.name, people.department, people.jobTitle)
      .orderBy(desc(sql`count(${assets.id})`), people.name)
      .limit(TOP_HOLDERS_LIMIT),
  ]);

  const byTypeMap = new Map<AssetType, AssignmentTypeRow>();
  for (const r of typeRows) {
    byTypeMap.set(r.type, {
      type: r.type,
      total: r.total,
      assigned: r.assigned,
      unassigned: r.total - r.assigned,
    });
  }
  const byType = ASSET_TYPE_ORDER.filter((t) => byTypeMap.has(t)).map(
    (t) => byTypeMap.get(t)!,
  );

  const total = byType.reduce((sum, r) => sum + r.total, 0);
  const assigned = byType.reduce((sum, r) => sum + r.assigned, 0);

  return {
    total,
    assigned,
    unassigned: total - assigned,
    peopleWithDevices: holderRows.length,
    byType,
    topHolders: holderRows,
  };
}
