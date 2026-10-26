/**
 * Device-group filter rules (client-safe). Used by forms and by the DB resolve
 * path to decide whether a rule set is meaningful enough to save.
 */

import type { DeviceGroupRules } from "@/db/schema";

export type DeviceGroupCompliance = "any" | "at-risk" | "ok";

export function normalizeDeviceGroupRules(
  raw: DeviceGroupRules | null | undefined,
): DeviceGroupRules {
  const locationId =
    typeof raw?.locationId === "string" && raw.locationId.trim()
      ? raw.locationId.trim()
      : null;
  const osContains =
    typeof raw?.osContains === "string" && raw.osContains.trim()
      ? raw.osContains.trim()
      : null;
  const compliance: DeviceGroupCompliance =
    raw?.compliance === "at-risk" || raw?.compliance === "ok"
      ? raw.compliance
      : "any";
  return { locationId, osContains, compliance };
}

/** True when at least one filter would narrow the fleet. */
export function hasMeaningfulDeviceGroupRules(
  rules: DeviceGroupRules | null | undefined,
): boolean {
  const n = normalizeDeviceGroupRules(rules);
  if (n.locationId) return true;
  if (n.osContains) return true;
  if (n.compliance === "at-risk" || n.compliance === "ok") return true;
  return false;
}
