import "server-only";

import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import { getSubtreeIds } from "./queries";
import { db } from "./index";
import {
  assets,
  computerDetails,
  type ScriptTargetSpec,
} from "./schema";

/** A Computer with an IP, ready to enqueue a script-run job. */
export type ResolvedScriptTarget = {
  assetId: string;
  tag: string;
  ip: string;
};

export type ResolveTargetsResult = {
  resolved: ResolvedScriptTarget[];
  /** Computers matched by the spec but missing an IP (skipped, not enqueued). */
  skippedNoIp: number;
};

function uniqTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((t) => t.trim()).filter(Boolean)),
  );
}

/**
 * Resolve a frozen targetSpec to Computers with IPs (spec 32 v2).
 * Tags mode = multi-select asset tags. Location mode = location subtree.
 * Hosts without an IP are counted in skippedNoIp and omitted from resolved.
 */
export async function resolveScriptTargets(
  spec: ScriptTargetSpec,
): Promise<ResolveTargetsResult> {
  if (spec.mode === "tags") {
    const tags = uniqTags(spec.tags);
    if (tags.length === 0) return { resolved: [], skippedNoIp: 0 };

    const rows = await db
      .select({
        assetId: assets.id,
        tag: assets.tag,
        ip: computerDetails.ipAddress,
      })
      .from(assets)
      .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
      .where(and(eq(assets.type, "Computer"), inArray(assets.tag, tags)));

    return splitByIp(rows);
  }

  const subtree = await getSubtreeIds(spec.locationId);
  if (subtree.length === 0) return { resolved: [], skippedNoIp: 0 };

  const rows = await db
    .select({
      assetId: assets.id,
      tag: assets.tag,
      ip: computerDetails.ipAddress,
    })
    .from(assets)
    .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
    .where(
      and(eq(assets.type, "Computer"), inArray(assets.locationId, subtree)),
    );

  return splitByIp(rows);
}

function splitByIp(
  rows: Array<{ assetId: string; tag: string; ip: string | null }>,
): ResolveTargetsResult {
  const resolved: ResolvedScriptTarget[] = [];
  let skippedNoIp = 0;
  for (const r of rows) {
    if (!r.ip) {
      skippedNoIp += 1;
      continue;
    }
    resolved.push({ assetId: r.assetId, tag: r.tag, ip: r.ip });
  }
  return { resolved, skippedNoIp };
}

/** Lightweight Computer picker list for Run-on… (tag + name). */
export async function listComputerPickerOptions(): Promise<
  Array<{ tag: string; name: string }>
> {
  const rows = await db
    .select({
      tag: assets.tag,
      name: assets.name,
      ip: computerDetails.ipAddress,
    })
    .from(assets)
    .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
    .where(and(eq(assets.type, "Computer"), isNotNull(computerDetails.ipAddress)))
    .orderBy(asc(assets.tag));
  return rows.map((r) => ({ tag: r.tag, name: r.name }));
}
