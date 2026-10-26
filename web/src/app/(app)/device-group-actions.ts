"use server";

import { revalidatePath } from "next/cache";

import {
  createDeviceGroup,
  deleteDeviceGroup,
  updateDeviceGroup,
} from "@/db/device-groups";
import { resolveDeviceGroupRules } from "@/db/script-targets";
import type { DeviceGroupRules } from "@/db/schema";
import {
  hasMeaningfulDeviceGroupRules,
  normalizeDeviceGroupRules,
} from "@/lib/device-group-rules";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to manage device groups.",
};

function revalidate() {
  revalidatePath("/device-groups");
  revalidatePath("/scripts");
}

function parseRules(raw: unknown): DeviceGroupRules | null {
  if (!raw || typeof raw !== "object") return null;
  return normalizeDeviceGroupRules(raw as DeviceGroupRules);
}

export async function createDeviceGroupAction(input: {
  name: unknown;
  description?: unknown;
  rules: unknown;
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const name = typeof input.name === "string" ? input.name : "";
  const description =
    typeof input.description === "string" ? input.description : null;
  const rules = parseRules(input.rules);
  if (!rules || !hasMeaningfulDeviceGroupRules(rules)) {
    return {
      ok: false,
      error: "Add at least one filter (location, OS, or compliance).",
    };
  }

  const res = await createDeviceGroup({
    name,
    description,
    rules,
    actorEmail: user.email,
  });
  if (!res.ok) {
    if (res.reason === "empty-name") {
      return { ok: false, error: "Name is required." };
    }
    if (res.reason === "name-taken") {
      return { ok: false, error: "A group with that name already exists." };
    }
    return { ok: false, error: "Could not create that group." };
  }
  revalidate();
  return { ok: true, message: "Device group created." };
}

export async function updateDeviceGroupAction(input: {
  id: unknown;
  name: unknown;
  description?: unknown;
  rules: unknown;
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const id = typeof input.id === "string" ? input.id : "";
  if (!id) return { ok: false, error: "Unknown device group." };

  const name = typeof input.name === "string" ? input.name : "";
  const description =
    typeof input.description === "string" ? input.description : null;
  const rules = parseRules(input.rules);
  if (!rules || !hasMeaningfulDeviceGroupRules(rules)) {
    return {
      ok: false,
      error: "Add at least one filter (location, OS, or compliance).",
    };
  }

  const res = await updateDeviceGroup(id, {
    name,
    description,
    rules,
    actorEmail: user.email,
  });
  if (!res.ok) {
    if (res.reason === "notfound") {
      return { ok: false, error: "That group is no longer there." };
    }
    if (res.reason === "empty-name") {
      return { ok: false, error: "Name is required." };
    }
    if (res.reason === "name-taken") {
      return { ok: false, error: "A group with that name already exists." };
    }
    return { ok: false, error: "Could not update that group." };
  }
  revalidate();
  return { ok: true, message: "Device group updated." };
}

export async function deleteDeviceGroupAction(
  id: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown device group." };
  }
  const ok = await deleteDeviceGroup(id);
  if (!ok) return { ok: false, error: "That group is no longer there." };
  revalidate();
  return { ok: true, message: "Deleted that group." };
}

/** Live membership preview for the form (no enqueue). */
export async function previewDeviceGroupAction(input: {
  rules: unknown;
}): Promise<
  | { ok: true; matched: number; withIp: number; sampleTags: string[] }
  | { ok: false; error: string }
> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) {
    return { ok: false, error: FORBIDDEN.error };
  }
  const rules = parseRules(input.rules);
  if (!rules || !hasMeaningfulDeviceGroupRules(rules)) {
    return { ok: true, matched: 0, withIp: 0, sampleTags: [] };
  }
  const result = await resolveDeviceGroupRules(rules);
  const withIp = result.resolved.length;
  const matched = withIp + result.skippedNoIp;
  return {
    ok: true,
    matched,
    withIp,
    sampleTags: result.resolved.slice(0, 8).map((r) => r.tag),
  };
}
