import "server-only";

import { db } from "./index";
import { discoverySettings } from "./schema";

/**
 * Discovery type toggles (spec 13). Per-type on/off switches for what the
 * collector automatically discovers. The web app owns the switches; the
 * collector pulls them before each automatic sweep (GET /api/scan/discovery-
 * settings) and skips an off type. Everything here is server-only.
 *
 * Invariant: an absent row means the type's default (AC-2) — computers/printers
 * default on, phones default **off** (opt-in, spec 27). Reads coalesce a missing
 * type to that default, so no seeding is needed.
 */

/** The device types that can be toggled today (the ones the collector classifies). */
export const DISCOVERY_TYPES = ["computer", "printer", "phone"] as const;
export type DiscoveryType = (typeof DISCOVERY_TYPES)[number];

/** Default auto-discovery state per type when there's no saved row. Computers and
   printers are on (the long-standing fleet behavior); VoIP phones are **opt-in**
   (spec 27) — auto-sweep stays off until an admin turns it on, and phones are
   otherwise added/scanned manually. */
const DEFAULT_ENABLED: Record<DiscoveryType, boolean> = {
  computer: true,
  printer: true,
  phone: false,
};

export type DiscoverySettings = Record<DiscoveryType, boolean>;

export function isDiscoveryType(value: unknown): value is DiscoveryType {
  return (
    typeof value === "string" &&
    (DISCOVERY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Read the current switch state for every toggleable type (AC-2). A type with no
 * saved row defaults to on, so a fresh (empty) table returns all types enabled.
 */
export async function getDiscoverySettings(): Promise<DiscoverySettings> {
  const rows = await db
    .select({
      deviceType: discoverySettings.deviceType,
      enabled: discoverySettings.enabled,
    })
    .from(discoverySettings);

  const saved = new Map(rows.map((r) => [r.deviceType, r.enabled]));
  // Coalesce a missing type to its default (computers/printers on, phones opt-in).
  const out = {} as DiscoverySettings;
  for (const type of DISCOVERY_TYPES) {
    out[type] = saved.get(type) ?? DEFAULT_ENABLED[type];
  }
  return out;
}

/**
 * Turn one type on or off (AC-1). Upserts the single row, so flipping a switch
 * never depends on a row already existing. Callers gate on `scan:write` first.
 */
export async function setDiscoveryToggle(
  deviceType: DiscoveryType,
  enabled: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .insert(discoverySettings)
    .values({ deviceType, enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: discoverySettings.deviceType,
      set: { enabled, updatedAt: now },
    });
}
