"use server";

import { revalidatePath } from "next/cache";

import { cancelRebootJob, enqueueRebootJob } from "@/db/reboot";
import {
  deleteRebootSchedule,
  setRebootScheduleEnabled,
  upsertRebootSchedule,
} from "@/db/reboot-schedules";
import { resolveDeployTarget } from "@/db/patch-install";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { RebootCadence } from "@/lib/reboot-occurrence";

/**
 * Cookie-side actions for scheduled reboot (spec 31 v2). Gated on `software:deploy`.
 */

type ActionOk = { ok: true; id?: string };
type ActionErr = {
  ok: false;
  error: string;
  code?: "forbidden" | "notfound" | "conflict" | "badrequest";
};

const FORBIDDEN: ActionErr = {
  ok: false,
  error: "You don't have permission to schedule reboots.",
  code: "forbidden",
};

export async function requestRebootSchedule(input: {
  assetTag: string;
  scheduledAtIso: string;
}): Promise<ActionOk | ActionErr> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const tag = (input.assetTag ?? "").trim();
  if (!tag) return { ok: false, error: "Missing asset.", code: "badrequest" };

  const iso = (input.scheduledAtIso ?? "").trim();
  if (!iso) {
    return {
      ok: false,
      error: "Pick a date and time for the reboot.",
      code: "badrequest",
    };
  }
  const scheduledAt = new Date(iso);
  if (Number.isNaN(scheduledAt.getTime())) {
    return {
      ok: false,
      error: "Invalid schedule time.",
      code: "badrequest",
    };
  }

  const target = await resolveDeployTarget(tag);
  if (!target) {
    return {
      ok: false,
      error: "Computer needs an IP address before it can be rebooted.",
      code: "badrequest",
    };
  }

  const enq = await enqueueRebootJob({
    assetId: target.assetId,
    targetIp: target.ip,
    scheduledAt,
    requestedBy: user.email,
  });
  if (!enq.ok) {
    if (enq.reason === "past-schedule") {
      return {
        ok: false,
        error: "Schedule time must be in the future.",
        code: "badrequest",
      };
    }
    return {
      ok: false,
      error: "A reboot is already scheduled or in progress on this computer.",
      code: "conflict",
    };
  }

  revalidatePath(`/assets/${tag}`);
  return { ok: true, id: enq.id };
}

export async function requestCancelReboot(input: {
  id: string;
  assetTag: string;
}): Promise<ActionOk | ActionErr> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const canceled = await cancelRebootJob(input.id);
  if (!canceled) {
    return {
      ok: false,
      error: "Reboot job not found or already finished.",
      code: "conflict",
    };
  }

  const tag = (input.assetTag ?? "").trim();
  if (tag) revalidatePath(`/assets/${tag}`);
  return { ok: true };
}

const NO_DEPLOY_TARGET: ActionErr = {
  ok: false,
  error: "Computer needs an IP address before it can be rebooted.",
  code: "badrequest",
};

async function resolveScheduleAsset(tagInput: string): Promise<
  | { ok: true; tag: string; assetId: string; ip: string }
  | { ok: false; error: ActionErr }
> {
  const tag = (tagInput ?? "").trim();
  if (!tag) return { ok: false, error: { ok: false, error: "Missing asset.", code: "badrequest" } };
  const target = await resolveDeployTarget(tag);
  if (!target) return { ok: false, error: NO_DEPLOY_TARGET };
  return { ok: true, tag, assetId: target.assetId, ip: target.ip };
}

export async function upsertRebootScheduleAction(input: {
  assetTag: string;
  cadence: RebootCadence;
  weekdays?: number[];
  localTime: string;
  timezone: string;
}): Promise<ActionOk | ActionErr> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const resolved = await resolveScheduleAsset(input.assetTag);
  if (!resolved.ok) return resolved.error;

  const cadence = input.cadence;
  if (cadence !== "daily" && cadence !== "weekly") {
    return {
      ok: false,
      error: "Choose daily or weekly cadence.",
      code: "badrequest",
    };
  }

  const upserted = await upsertRebootSchedule({
    assetId: resolved.assetId,
    targetIp: resolved.ip,
    cadence,
    weekdays: cadence === "weekly" ? (input.weekdays ?? null) : null,
    localTime: (input.localTime ?? "").trim(),
    timezone: (input.timezone ?? "").trim(),
    requestedBy: user.email,
  });
  if (!upserted.ok) {
    return {
      ok: false,
      error: "Invalid recurring reboot schedule.",
      code: "badrequest",
    };
  }

  revalidatePath(`/assets/${resolved.tag}`);
  return { ok: true, id: upserted.id };
}

export async function setRebootScheduleEnabledAction(input: {
  assetTag: string;
  enabled: boolean;
}): Promise<ActionOk | ActionErr> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const resolved = await resolveScheduleAsset(input.assetTag);
  if (!resolved.ok) return resolved.error;

  const updated = await setRebootScheduleEnabled(
    resolved.assetId,
    input.enabled,
  );
  if (!updated) {
    return {
      ok: false,
      error: "No recurring reboot schedule on this computer.",
      code: "notfound",
    };
  }

  revalidatePath(`/assets/${resolved.tag}`);
  return { ok: true };
}

export async function deleteRebootScheduleAction(input: {
  assetTag: string;
}): Promise<ActionOk | ActionErr> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const resolved = await resolveScheduleAsset(input.assetTag);
  if (!resolved.ok) return resolved.error;

  const deleted = await deleteRebootSchedule(resolved.assetId);
  if (!deleted) {
    return {
      ok: false,
      error: "No recurring reboot schedule on this computer.",
      code: "notfound",
    };
  }

  revalidatePath(`/assets/${resolved.tag}`);
  return { ok: true };
}
