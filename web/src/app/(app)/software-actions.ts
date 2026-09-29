"use server";

import { revalidatePath } from "next/cache";

import { addTrackedSoftware, removeTrackedSoftware } from "@/db/software";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to manage tracked software.",
};

/**
 * Add a title to the software watchlist (spec 15, AC-1). Gated on `scan:write`,
 * rechecked server-side (AC-7): the Admin card hides the controls without it, and
 * this refuses the call even if invoked directly.
 */
export async function addTrackedSoftwareAction(
  name: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "scan:write")) return FORBIDDEN;

  if (typeof name !== "string") {
    return { ok: false, error: "A software title is required." };
  }

  const result = await addTrackedSoftware(name);
  if (result === "empty") {
    return { ok: false, error: "Enter a software title to track." };
  }
  if (result === "duplicate") {
    return { ok: false, error: `"${name.trim()}" is already tracked.` };
  }

  revalidatePath("/admin");
  revalidatePath("/software");
  return { ok: true, message: `Now tracking "${name.trim()}".` };
}

/**
 * Remove a title from the watchlist (spec 15, AC-1). Its recorded matches cascade
 * away. Gated on `scan:write`, rechecked server-side (AC-7).
 */
export async function removeTrackedSoftwareAction(
  id: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "scan:write")) return FORBIDDEN;

  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown software title." };
  }

  const removed = await removeTrackedSoftware(id);
  if (!removed) {
    return { ok: false, error: "That title is no longer tracked." };
  }

  revalidatePath("/admin");
  revalidatePath("/software");
  return { ok: true, message: "Stopped tracking that title." };
}
