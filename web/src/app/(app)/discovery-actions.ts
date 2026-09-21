"use server";

import { revalidatePath } from "next/cache";

import { isDiscoveryType, setDiscoveryToggle } from "@/db/discovery";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to change discovery settings.",
};

const TYPE_LABEL: Record<string, string> = {
  computer: "Computers",
  printer: "Printers",
};

/**
 * Turn automatic discovery of a device type on or off (spec 13, AC-1). Gated on
 * `scan:write`, rechecked server-side (AC-7): the UI hides the controls without
 * it, and this refuses the write even if called directly.
 */
export async function setDiscoveryToggleAction(
  deviceType: unknown,
  enabled: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "scan:write")) return FORBIDDEN;

  if (!isDiscoveryType(deviceType)) {
    return { ok: false, error: "Unknown device type." };
  }
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "Toggle state must be on or off." };
  }

  await setDiscoveryToggle(deviceType, enabled);
  revalidatePath("/admin");
  const label = TYPE_LABEL[deviceType] ?? deviceType;
  return {
    ok: true,
    message: `Automatic ${label} discovery turned ${enabled ? "on" : "off"}.`,
  };
}
