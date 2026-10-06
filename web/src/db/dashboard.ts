import "server-only";

import { db } from "./index";
import { dashboardWidgets } from "./schema";

/**
 * Dashboard widget toggles. Admin-managed on/off switches for optional dashboard
 * widgets (today just the Asset Locations map). Same "absent row = on" convention
 * as the discovery toggles (spec 13): a widget with no saved row defaults to
 * enabled, so a fresh (empty) table means every widget is on and no seeding is
 * needed. Everything here is server-only.
 */

export const DASHBOARD_WIDGETS = ["locations-map"] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGETS)[number];

export type DashboardWidgetSettings = Record<DashboardWidgetId, boolean>;

export function isDashboardWidgetId(value: unknown): value is DashboardWidgetId {
  return (
    typeof value === "string" &&
    (DASHBOARD_WIDGETS as readonly string[]).includes(value)
  );
}

/** Read every widget's on/off state; a widget with no saved row defaults to on. */
export async function getDashboardWidgetSettings(): Promise<DashboardWidgetSettings> {
  const rows = await db
    .select({
      widgetId: dashboardWidgets.widgetId,
      enabled: dashboardWidgets.enabled,
    })
    .from(dashboardWidgets);

  const saved = new Map(rows.map((r) => [r.widgetId, r.enabled]));
  const out = {} as DashboardWidgetSettings;
  for (const id of DASHBOARD_WIDGETS) {
    out[id] = saved.get(id) ?? true;
  }
  return out;
}

/** Turn one widget on or off (upsert, so it never depends on an existing row).
   Callers gate on `scan:write` first. */
export async function setDashboardWidget(
  widgetId: DashboardWidgetId,
  enabled: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .insert(dashboardWidgets)
    .values({ widgetId, enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: dashboardWidgets.widgetId,
      set: { enabled, updatedAt: now },
    });
}
