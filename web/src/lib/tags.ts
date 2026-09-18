import type { AssetType } from "@/lib/data";

/** Tag prefix per asset type. `OPUS-<PREFIX>-XXXXX`. */
export const TAG_PREFIX: Record<AssetType, string> = {
  Computer: "COMP",
  Monitor: "MON",
  Printer: "PRNT",
  Phone: "PHN",
  Network: "NET",
};

/**
 * OPUS-COMP-7F3K9 — prefix from the type, 5 random base36 chars.
 *
 * The one definition, shared by both create paths (the discovered-inbox
 * quick-create and the manual asset form) so the two cannot diverge.
 */
export function generateTag(type: AssetType): string {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `OPUS-${TAG_PREFIX[type]}-${suffix}`;
}
