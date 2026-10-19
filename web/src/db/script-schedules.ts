import "server-only";

import { and, asc, eq, lte } from "drizzle-orm";

import { computeNextRun } from "@/lib/script-schedule";
import type { ScriptScheduleInput } from "@/lib/script-schedule";

import { enqueueScriptBatch } from "./script-batches";
import { db } from "./index";
import { getScript } from "./scripts";
import {
  scriptSchedules,
  scripts,
  type ScriptScheduleRow,
  type ScriptTargetSpec,
} from "./schema";

export type SavedScriptSchedule = {
  id: string;
  scriptId: string;
  scriptName: string;
  targetSpec: ScriptTargetSpec;
  cadence: "daily" | "weekly";
  hour: number;
  minute: number;
  weekday: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function toSaved(
  row: ScriptScheduleRow,
  scriptName: string,
): SavedScriptSchedule {
  return {
    id: row.id,
    scriptId: row.scriptId,
    scriptName,
    targetSpec: row.targetSpec,
    cadence: row.cadence,
    hour: row.hour,
    minute: row.minute,
    weekday: row.weekday,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    nextRunAt: row.nextRunAt.toISOString(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listScriptSchedules(): Promise<SavedScriptSchedule[]> {
  const rows = await db
    .select({
      schedule: scriptSchedules,
      scriptName: scripts.name,
    })
    .from(scriptSchedules)
    .innerJoin(scripts, eq(scripts.id, scriptSchedules.scriptId))
    .orderBy(asc(scriptSchedules.nextRunAt));
  return rows.map((r) => toSaved(r.schedule, r.scriptName));
}

export async function createScriptSchedule(input: {
  scriptId: string;
  targetSpec: ScriptTargetSpec;
  schedule: ScriptScheduleInput;
  createdBy: string;
  enabled?: boolean;
}): Promise<SavedScriptSchedule> {
  const nextRunAt = computeNextRun(input.schedule, new Date());
  const [row] = await db
    .insert(scriptSchedules)
    .values({
      scriptId: input.scriptId,
      targetSpec: input.targetSpec,
      cadence: input.schedule.cadence,
      hour: input.schedule.hour,
      minute: input.schedule.minute,
      weekday: input.schedule.weekday ?? null,
      enabled: input.enabled ?? true,
      nextRunAt,
      createdBy: input.createdBy,
    })
    .returning();

  const script = await getScript(input.scriptId);
  return toSaved(row, script?.name ?? "(script)");
}

export async function updateScriptSchedule(
  id: string,
  input: {
    targetSpec?: ScriptTargetSpec;
    schedule?: ScriptScheduleInput;
    enabled?: boolean;
  },
): Promise<SavedScriptSchedule | null> {
  const [existing] = await db
    .select()
    .from(scriptSchedules)
    .where(eq(scriptSchedules.id, id))
    .limit(1);
  if (!existing) return null;

  const schedule: ScriptScheduleInput = input.schedule ?? {
    cadence: existing.cadence,
    hour: existing.hour,
    minute: existing.minute,
    weekday: existing.weekday,
  };
  const nextRunAt = computeNextRun(schedule, new Date());
  const now = new Date();

  const [row] = await db
    .update(scriptSchedules)
    .set({
      targetSpec: input.targetSpec ?? existing.targetSpec,
      cadence: schedule.cadence,
      hour: schedule.hour,
      minute: schedule.minute,
      weekday: schedule.weekday ?? null,
      enabled: input.enabled ?? existing.enabled,
      nextRunAt,
      updatedAt: now,
    })
    .where(eq(scriptSchedules.id, id))
    .returning();

  if (!row) return null;
  const script = await getScript(row.scriptId);
  return toSaved(row, script?.name ?? "(script)");
}

export async function deleteScriptSchedule(id: string): Promise<boolean> {
  const rows = await db
    .delete(scriptSchedules)
    .where(eq(scriptSchedules.id, id))
    .returning({ id: scriptSchedules.id });
  return rows.length > 0;
}

export async function listDueScriptSchedules(
  now: Date = new Date(),
): Promise<ScriptScheduleRow[]> {
  return db
    .select()
    .from(scriptSchedules)
    .where(
      and(eq(scriptSchedules.enabled, true), lte(scriptSchedules.nextRunAt, now)),
    )
    .orderBy(asc(scriptSchedules.nextRunAt));
}

export async function advanceScriptSchedule(
  id: string,
  ran: Date = new Date(),
): Promise<void> {
  const [row] = await db
    .select()
    .from(scriptSchedules)
    .where(eq(scriptSchedules.id, id))
    .limit(1);
  if (!row) return;
  const nextRunAt = computeNextRun(
    {
      cadence: row.cadence,
      hour: row.hour,
      minute: row.minute,
      weekday: row.weekday,
    },
    ran,
  );
  await db
    .update(scriptSchedules)
    .set({ lastRunAt: ran, nextRunAt, updatedAt: ran })
    .where(eq(scriptSchedules.id, id));
}

export type MaterializeDueResult = {
  due: number;
  fired: number;
  failed: number;
};

/**
 * Worker tick: for each due schedule, enqueue a batch and advance nextRunAt
 * (even on empty resolve — so a bad target doesn't stick forever).
 */
export async function materializeDueScriptSchedules(
  now: Date = new Date(),
): Promise<MaterializeDueResult> {
  const due = await listDueScriptSchedules(now);
  let fired = 0;
  let failed = 0;

  for (const sched of due) {
    try {
      const script = await getScript(sched.scriptId);
      if (!script || script.archivedAt) {
        await advanceScriptSchedule(sched.id, now);
        failed += 1;
        continue;
      }
      await enqueueScriptBatch({
        scriptId: script.id,
        scriptSnapshot: {
          name: script.name,
          body: script.body,
          timeoutSeconds: script.timeoutSeconds,
        },
        targetSpec: sched.targetSpec,
        source: "schedule",
        scheduleId: sched.id,
        requestedBy: `schedule:${sched.id}`,
      });
      await advanceScriptSchedule(sched.id, now);
      fired += 1;
    } catch (e) {
      console.error(`[script-schedules] materialize failed for ${sched.id}:`, e);
      try {
        await advanceScriptSchedule(sched.id, now);
      } catch {
        /* already logged */
      }
      failed += 1;
    }
  }

  return { due: due.length, fired, failed };
}
