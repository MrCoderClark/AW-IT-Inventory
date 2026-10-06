"use server";

import { revalidatePath } from "next/cache";

import { isDashboardWidgetId, setDashboardWidget } from "@/db/dashboard";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to change dashboard settings.",
};

const WIDGET_LABEL: Record<string, string> = {
  "locations-map": "Asset Locations map",
};

/**
 * Turn a dashboard widget on or off. Gated on `scan:write` (reused, like the
 * other Admin toggles — no new permission), rechecked server-side: the UI hides
 * the controls without it, and this refuses the write even if called directly.
 */
export async function setDashboardWidgetAction(
  widgetId: unknown,
  enabled: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "scan:write")) return FORBIDDEN;

  if (!isDashboardWidgetId(widgetId)) {
    return { ok: false, error: "Unknown dashboard widget." };
  }
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "Toggle state must be on or off." };
  }

  await setDashboardWidget(widgetId, enabled);
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  const label = WIDGET_LABEL[widgetId] ?? widgetId;
  return {
    ok: true,
    message: `${label} turned ${enabled ? "on" : "off"}.`,
  };
}
