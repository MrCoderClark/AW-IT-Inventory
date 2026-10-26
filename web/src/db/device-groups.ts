import "server-only";

import { asc, eq } from "drizzle-orm";

import {
  hasMeaningfulDeviceGroupRules,
  normalizeDeviceGroupRules,
} from "@/lib/device-group-rules";
import { db } from "./index";
import {
  deviceGroups,
  type DeviceGroupRules,
  type DeviceGroupRow,
} from "./schema";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeviceGroupListItem = {
  id: string;
  name: string;
  description: string | null;
  rules: DeviceGroupRules;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

function toListItem(row: DeviceGroupRow): DeviceGroupListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: normalizeDeviceGroupRules(row.rules),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listDeviceGroups(): Promise<DeviceGroupListItem[]> {
  const rows = await db
    .select()
    .from(deviceGroups)
    .orderBy(asc(deviceGroups.name));
  return rows.map(toListItem);
}

export async function getDeviceGroup(
  id: string,
): Promise<DeviceGroupListItem | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select()
    .from(deviceGroups)
    .where(eq(deviceGroups.id, id))
    .limit(1);
  return row ? toListItem(row) : null;
}

export type UpsertDeviceGroupInput = {
  name: string;
  description?: string | null;
  rules: DeviceGroupRules;
  actorEmail: string;
};

export type UpsertDeviceGroupResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: "empty-name" | "empty-rules" | "name-taken" | "notfound";
    };

export async function createDeviceGroup(
  input: UpsertDeviceGroupInput,
): Promise<UpsertDeviceGroupResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: "empty-name" };
  const rules = normalizeDeviceGroupRules(input.rules);
  if (!hasMeaningfulDeviceGroupRules(rules)) {
    return { ok: false, reason: "empty-rules" };
  }

  try {
    const [row] = await db
      .insert(deviceGroups)
      .values({
        name,
        description: input.description?.trim() || null,
        rules,
        createdBy: input.actorEmail,
        updatedBy: input.actorEmail,
      })
      .returning({ id: deviceGroups.id });
    return { ok: true, id: row.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "name-taken" };
    throw err;
  }
}

export async function updateDeviceGroup(
  id: string,
  input: UpsertDeviceGroupInput,
): Promise<UpsertDeviceGroupResult> {
  if (!UUID_RE.test(id)) return { ok: false, reason: "notfound" };
  const name = input.name.trim();
  if (!name) return { ok: false, reason: "empty-name" };
  const rules = normalizeDeviceGroupRules(input.rules);
  if (!hasMeaningfulDeviceGroupRules(rules)) {
    return { ok: false, reason: "empty-rules" };
  }

  try {
    const updated = await db
      .update(deviceGroups)
      .set({
        name,
        description: input.description?.trim() || null,
        rules,
        updatedBy: input.actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(deviceGroups.id, id))
      .returning({ id: deviceGroups.id });
    if (updated.length === 0) return { ok: false, reason: "notfound" };
    return { ok: true, id: id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "name-taken" };
    throw err;
  }
}

export async function deleteDeviceGroup(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const deleted = await db
    .delete(deviceGroups)
    .where(eq(deviceGroups.id, id))
    .returning({ id: deviceGroups.id });
  return deleted.length > 0;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (code === "23505") return true;
  const msg = String((err as { message?: string }).message ?? "");
  return /unique|duplicate/i.test(msg);
}

/** Lightweight picker for script Run on… / schedules. */
export async function listDeviceGroupOptions(): Promise<
  Array<{ id: string; name: string }>
> {
  const rows = await db
    .select({ id: deviceGroups.id, name: deviceGroups.name })
    .from(deviceGroups)
    .orderBy(asc(deviceGroups.name));
  return rows;
}
