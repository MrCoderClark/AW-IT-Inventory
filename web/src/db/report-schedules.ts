import "server-only";

import { and, asc, eq, inArray, lte } from "drizzle-orm";

import { db } from "./index";
import { reportSchedules } from "./schema";
import {
  computeNextRun,
  type Cadence,
  type ScheduleInput,
} from "@/lib/report-schedule";

/* Report delivery schedules (spec 26 phase 2). The cadence math lives in the pure
   `@/lib/report-schedule`; this module stores schedules and evaluates which are
   due. One schedule per report (unique reportId). Server-only. */

export interface SavedSchedule {
  id: string;
  reportId: string;
  cadence: Cadence;
  hour: number;
  minute: number;
  weekday: number | null;
  dayOfMonth: number | null;
  recipients: string[];
  format: "csv" | "xlsx";
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  updatedAt: string;
}

function toSaved(r: typeof reportSchedules.$inferSelect): SavedSchedule {
  return {
    id: r.id,
    reportId: r.reportId,
    cadence: r.cadence,
    hour: r.hour,
    minute: r.minute,
    weekday: r.weekday,
    dayOfMonth: r.dayOfMonth,
    recipients: r.recipients,
    format: r.format === "xlsx" ? "xlsx" : "csv",
    enabled: r.enabled,
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    nextRunAt: r.nextRunAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function getScheduleForReport(
  reportId: string,
): Promise<SavedSchedule | null> {
  const [r] = await db
    .select()
    .from(reportSchedules)
    .where(eq(reportSchedules.reportId, reportId))
    .limit(1);
  return r ? toSaved(r) : null;
}

/** Schedules for a set of reports, keyed by reportId — for the hub's badges. */
export async function getSchedulesByReport(
  reportIds: string[],
): Promise<Record<string, SavedSchedule>> {
  if (reportIds.length === 0) return {};
  const rows = await db
    .select()
    .from(reportSchedules)
    .where(inArray(reportSchedules.reportId, reportIds));
  return Object.fromEntries(rows.map((r) => [r.reportId, toSaved(r)]));
}

/** Create or replace a report's schedule. `enabled` defaults to true. Recomputes
   `nextRunAt` from `now`. */
export async function upsertSchedule(
  reportId: string,
  input: ScheduleInput,
  opts: { enabled?: boolean; createdBy?: string | null } = {},
): Promise<SavedSchedule> {
  const nextRunAt = computeNextRun(input);
  const values = {
    reportId,
    cadence: input.cadence,
    hour: input.hour,
    minute: input.minute,
    weekday: input.weekday ?? null,
    dayOfMonth: input.dayOfMonth ?? null,
    recipients: input.recipients,
    format: input.format,
    enabled: opts.enabled ?? true,
    nextRunAt,
    createdBy: opts.createdBy ?? null,
  };
  const [r] = await db
    .insert(reportSchedules)
    .values(values)
    .onConflictDoUpdate({
      target: reportSchedules.reportId,
      set: {
        cadence: values.cadence,
        hour: values.hour,
        minute: values.minute,
        weekday: values.weekday,
        dayOfMonth: values.dayOfMonth,
        recipients: values.recipients,
        format: values.format,
        enabled: values.enabled,
        nextRunAt: values.nextRunAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  return toSaved(r);
}

export async function deleteSchedule(reportId: string): Promise<boolean> {
  const rows = await db
    .delete(reportSchedules)
    .where(eq(reportSchedules.reportId, reportId))
    .returning({ id: reportSchedules.id });
  return rows.length > 0;
}

/** Enabled schedules whose `nextRunAt` has passed — the delivery sweep's work
   list (spec 26 phase 2, slice 2b). */
export async function listDueSchedules(
  now: Date = new Date(),
): Promise<SavedSchedule[]> {
  const rows = await db
    .select()
    .from(reportSchedules)
    .where(
      and(eq(reportSchedules.enabled, true), lte(reportSchedules.nextRunAt, now)),
    )
    .orderBy(asc(reportSchedules.nextRunAt));
  return rows.map(toSaved);
}

/** After a (attempted) delivery: stamp `lastRunAt` and roll `nextRunAt` forward
   so a schedule fires once per period even if the sweep runs often (slice 2b). */
export async function advanceSchedule(
  id: string,
  ran: Date = new Date(),
): Promise<void> {
  const [row] = await db
    .select()
    .from(reportSchedules)
    .where(eq(reportSchedules.id, id))
    .limit(1);
  if (!row) return;
  const nextRunAt = computeNextRun(
    {
      cadence: row.cadence,
      hour: row.hour,
      minute: row.minute,
      weekday: row.weekday,
      dayOfMonth: row.dayOfMonth,
    },
    ran,
  );
  await db
    .update(reportSchedules)
    .set({ lastRunAt: ran, nextRunAt })
    .where(eq(reportSchedules.id, id));
}
