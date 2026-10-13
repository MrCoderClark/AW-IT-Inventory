"use server";

import { revalidatePath } from "next/cache";

import { dismissMonitor, restoreDismissedMonitor } from "@/db/monitors";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to manage monitors.",
};

/**
 * Hide a scanned display from the /monitors "Discovered displays" list (spec 25
 * follow-up). Gated on `asset:write` (same as creating an asset), rechecked here:
 * the list hides the controls without it, this refuses a direct call. Idempotent.
 */
export async function dismissDiscoveredMonitor(
  serial: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "asset:write")) return FORBIDDEN;

  if (typeof serial !== "string" || !serial.trim()) {
    return { ok: false, error: "Unknown display." };
  }

  await dismissMonitor(serial, user?.email ?? null);
  revalidatePath("/monitors");
  return { ok: true, message: "Display dismissed." };
}

/** Undo a dismiss — bring a serial back onto the discovery list. */
export async function restoreDiscoveredMonitor(
  serial: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "asset:write")) return FORBIDDEN;

  if (typeof serial !== "string" || !serial.trim()) {
    return { ok: false, error: "Unknown display." };
  }

  await restoreDismissedMonitor(serial);
  revalidatePath("/monitors");
  return { ok: true, message: "Display restored to the discovery list." };
}
