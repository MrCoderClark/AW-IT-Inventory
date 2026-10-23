import "server-only";

import { and, eq, inArray, or, sql } from "drizzle-orm";

import {
  nextRebootOccurrence,
  type RebootCadence,
} from "@/lib/reboot-occurrence";

import { upsertAuditEvent } from "./computer-audit";
import { db } from "./index";
import { cancelRebootJob, enqueueRebootJob } from "./reboot";
import {
  assets,
  computerDetails,
  rebootJobs,
  rebootSchedules,
} from "./schema";

/**
 * Recurring reboot schedules (spec 31 v2). One row per asset; the next
 * occurrence is a normal reboot_jobs child linked by sourceScheduleId.
 * reboot.ts must not import this module — Task 4 hooks the terminal path.
 */

const IN_FLIGHT = ["pending", "claimed", "running"] as const;

const SCHEDULE_AUDIT_TABLE = "reboot_schedules";

function scheduleOperator(
  actorEmail: string | undefined,
  requestedBy: string | undefined,
): string {
  const actor = actorEmail?.trim();
  if (actor) return actor;
  const owner = requestedBy?.trim();
  if (owner) return owner;
  return "system";
}

async function auditScheduleChange(input: {
  scheduleId: string;
  assetId: string;
  operator: string;
  summary: string;
  status: "succeeded" | "canceled";
  details?: Record<string, unknown>;
}): Promise<void> {
  await upsertAuditEvent({
    sourceTable: SCHEDULE_AUDIT_TABLE,
    sourceId: input.scheduleId,
    assetId: input.assetId,
    action: "reboot_schedule",
    operator: input.operator,
    source: "admin_console",
    summary: input.summary,
    details: input.details,
    status: input.status,
  });
}

export type ScheduleListItem = {
  id: string;
  assetId: string;
  cadence: RebootCadence;
  weekdays: number[] | null;
  localTime: string;
  timezone: string;
  enabled: boolean;
  requestedBy: string;
  nextJobId: string | null;
  nextRunAtIso: string | null;
};

export type UpsertRebootScheduleInput = {
  assetId: string;
  targetIp: string;
  cadence: RebootCadence;
  weekdays: number[] | null;
  localTime: string;
  timezone: string;
  requestedBy: string;
};

export type UpsertRebootScheduleResult =
  | { ok: true; id: string }
  | { ok: false; reason: "bad-input" };

async function cancelInFlightForSchedule(
  scheduleId: string,
  nextJobId: string | null,
): Promise<void> {
  const owned = eq(rebootJobs.sourceScheduleId, scheduleId);
  const match = nextJobId
    ? or(owned, eq(rebootJobs.id, nextJobId))
    : owned;
  const children = await db
    .select({ id: rebootJobs.id })
    .from(rebootJobs)
    .where(and(inArray(rebootJobs.status, [...IN_FLIGHT]), match));
  for (const child of children) {
    await cancelRebootJob(child.id);
  }
}

async function resolveTargetIp(
  assetId: string,
  override: string | null,
): Promise<string | null> {
  const direct = override?.trim();
  if (direct) return direct;
  const [row] = await db
    .select({ ip: computerDetails.ipAddress })
    .from(computerDetails)
    .where(eq(computerDetails.assetId, assetId))
    .limit(1);
  const ip = row?.ip?.trim();
  return ip ? ip : null;
}

async function materializeRebootScheduleWithIp(
  scheduleId: string,
  targetIpOverride: string | null,
): Promise<"created" | "skipped" | "disabled" | "notfound"> {
  const [schedule] = await db
    .select()
    .from(rebootSchedules)
    .where(eq(rebootSchedules.id, scheduleId))
    .limit(1);
  if (!schedule) return "notfound";
  if (!schedule.enabled) return "disabled";

  const [inflight] = await db
    .select({ id: rebootJobs.id })
    .from(rebootJobs)
    .where(
      and(
        eq(rebootJobs.assetId, schedule.assetId),
        inArray(rebootJobs.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inflight) return "skipped";

  const targetIp = await resolveTargetIp(schedule.assetId, targetIpOverride);
  if (!targetIp) return "skipped";

  let scheduledAt: Date;
  try {
    scheduledAt = nextRebootOccurrence({
      cadence: schedule.cadence,
      weekdays: schedule.weekdays,
      localTime: schedule.localTime,
      timezone: schedule.timezone,
    });
  } catch {
    return "skipped";
  }

  const enqueued = await enqueueRebootJob({
    assetId: schedule.assetId,
    targetIp,
    scheduledAt,
    requestedBy: schedule.requestedBy,
    sourceScheduleId: schedule.id,
  });
  if (!enqueued.ok) return "skipped";

  await db
    .update(rebootSchedules)
    .set({ nextJobId: enqueued.id, updatedAt: new Date() })
    .where(eq(rebootSchedules.id, schedule.id));
  return "created";
}

export function materializeRebootSchedule(
  scheduleId: string,
): Promise<"created" | "skipped" | "disabled" | "notfound"> {
  return materializeRebootScheduleWithIp(scheduleId, null);
}

export async function upsertRebootSchedule(
  input: UpsertRebootScheduleInput,
): Promise<UpsertRebootScheduleResult> {
  const targetIp = input.targetIp.trim();
  if (!targetIp) return { ok: false, reason: "bad-input" };
  if (input.cadence !== "daily" && input.cadence !== "weekly") {
    return { ok: false, reason: "bad-input" };
  }
  try {
    nextRebootOccurrence({
      cadence: input.cadence,
      weekdays: input.weekdays,
      localTime: input.localTime,
      timezone: input.timezone,
    });
  } catch {
    return { ok: false, reason: "bad-input" };
  }

  const now = new Date();
  const weekdays = input.cadence === "weekly" ? input.weekdays : null;
  const [saved] = await db
    .insert(rebootSchedules)
    .values({
      assetId: input.assetId,
      cadence: input.cadence,
      weekdays,
      localTime: input.localTime,
      timezone: input.timezone,
      enabled: true,
      requestedBy: input.requestedBy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rebootSchedules.assetId,
      set: {
        cadence: input.cadence,
        weekdays,
        localTime: input.localTime,
        timezone: input.timezone,
        enabled: true,
        requestedBy: input.requestedBy,
        updatedAt: now,
      },
    })
    .returning({
      id: rebootSchedules.id,
      nextJobId: rebootSchedules.nextJobId,
    });
  if (!saved) return { ok: false, reason: "bad-input" };

  await auditScheduleChange({
    scheduleId: saved.id,
    assetId: input.assetId,
    operator: scheduleOperator(input.requestedBy, undefined),
    summary: `Saved ${input.cadence} reboot at ${input.localTime} ${input.timezone}`,
    status: "succeeded",
    details: {
      cadence: input.cadence,
      weekdays,
      localTime: input.localTime,
      timezone: input.timezone,
      enabled: true,
    },
  });

  await cancelInFlightForSchedule(saved.id, saved.nextJobId);
  await materializeRebootScheduleWithIp(saved.id, targetIp);
  return { ok: true, id: saved.id };
}

export async function setRebootScheduleEnabled(
  assetId: string,
  enabled: boolean,
  actorEmail?: string,
): Promise<boolean> {
  const [row] = await db
    .update(rebootSchedules)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(rebootSchedules.assetId, assetId))
    .returning({
      id: rebootSchedules.id,
      nextJobId: rebootSchedules.nextJobId,
      requestedBy: rebootSchedules.requestedBy,
    });
  if (!row) return false;

  await auditScheduleChange({
    scheduleId: row.id,
    assetId,
    operator: scheduleOperator(actorEmail, row.requestedBy),
    summary: enabled ? "Enabled recurring reboot" : "Disabled recurring reboot",
    status: "succeeded",
    details: { enabled },
  });

  if (!enabled) {
    await cancelInFlightForSchedule(row.id, row.nextJobId);
    await db
      .update(rebootSchedules)
      .set({ nextJobId: null, updatedAt: new Date() })
      .where(eq(rebootSchedules.id, row.id));
    return true;
  }

  await materializeRebootSchedule(row.id);
  return true;
}

export async function deleteRebootSchedule(
  assetId: string,
  actorEmail?: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      id: rebootSchedules.id,
      nextJobId: rebootSchedules.nextJobId,
      requestedBy: rebootSchedules.requestedBy,
    })
    .from(rebootSchedules)
    .where(eq(rebootSchedules.assetId, assetId))
    .limit(1);
  if (!row) return false;

  await cancelInFlightForSchedule(row.id, row.nextJobId);
  const deleted = await db
    .delete(rebootSchedules)
    .where(eq(rebootSchedules.assetId, assetId))
    .returning({ id: rebootSchedules.id });
  if (!deleted.length) return false;

  await auditScheduleChange({
    scheduleId: row.id,
    assetId,
    operator: scheduleOperator(actorEmail, row.requestedBy),
    summary: "Deleted recurring reboot schedule",
    status: "canceled",
    details: { deleted: true },
  });
  return true;
}

export async function getRebootScheduleForAssetTag(
  tag: string,
): Promise<ScheduleListItem | null> {
  const [row] = await db
    .select({
      id: rebootSchedules.id,
      assetId: rebootSchedules.assetId,
      cadence: rebootSchedules.cadence,
      weekdays: rebootSchedules.weekdays,
      localTime: rebootSchedules.localTime,
      timezone: rebootSchedules.timezone,
      enabled: rebootSchedules.enabled,
      requestedBy: rebootSchedules.requestedBy,
      nextJobId: rebootSchedules.nextJobId,
    })
    .from(rebootSchedules)
    .innerJoin(assets, eq(assets.id, rebootSchedules.assetId))
    .where(eq(assets.tag, tag))
    .limit(1);
  if (!row) return null;

  let nextRunAtIso: string | null = null;
  if (row.enabled) {
    try {
      nextRunAtIso = nextRebootOccurrence({
        cadence: row.cadence,
        weekdays: row.weekdays,
        localTime: row.localTime,
        timezone: row.timezone,
      }).toISOString();
    } catch {
      nextRunAtIso = null;
    }
  }

  return { ...row, nextRunAtIso };
}

export async function materializeDueRebootSchedules(): Promise<{
  checked: number;
  created: number;
}> {
  const due = await db
    .select({ id: rebootSchedules.id })
    .from(rebootSchedules)
    .where(
      and(
        eq(rebootSchedules.enabled, true),
        sql`not exists (
          select 1 from ${rebootJobs}
          where ${rebootJobs.assetId} = ${rebootSchedules.assetId}
            and ${rebootJobs.status} in ('pending', 'claimed', 'running')
        )`,
      ),
    );

  let created = 0;
  for (const row of due) {
    if ((await materializeRebootSchedule(row.id)) === "created") created += 1;
  }
  return { checked: due.length, created };
}

export async function onScheduleJobTerminal(jobId: string): Promise<void> {
  const [job] = await db
    .select({
      id: rebootJobs.id,
      sourceScheduleId: rebootJobs.sourceScheduleId,
    })
    .from(rebootJobs)
    .where(eq(rebootJobs.id, jobId))
    .limit(1);
  if (!job?.sourceScheduleId) return;

  await db
    .update(rebootSchedules)
    .set({ nextJobId: null, updatedAt: new Date() })
    .where(
      and(
        eq(rebootSchedules.id, job.sourceScheduleId),
        eq(rebootSchedules.nextJobId, job.id),
      ),
    );

  await materializeRebootSchedule(job.sourceScheduleId);
}
