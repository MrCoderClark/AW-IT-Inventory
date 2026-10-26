import "server-only";

import { and, asc, eq, ilike, inArray, isNotNull } from "drizzle-orm";

import {
  isAtRisk,
  scoreCompliance,
  type CompliancePosture,
} from "@/lib/compliance-score";
import { normalizeDeviceGroupRules } from "@/lib/device-group-rules";
import { getDeviceGroup } from "./device-groups";
import { getSubtreeIds } from "./queries";
import { db } from "./index";
import {
  assets,
  complianceStatus,
  computerDetails,
  machines,
  type DeviceGroupRules,
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
 * Resolve a frozen targetSpec to Computers with IPs (spec 32 v2 / device groups).
 * Tags = multi-select asset tags. Location = location subtree. Group = dynamic
 * device_groups rules. Hosts without an IP are counted in skippedNoIp.
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

  if (spec.mode === "group") {
    return resolveDeviceGroup(spec.groupId);
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

/**
 * Match Computers against a saved device group's rules, then gate on IP.
 * Missing / empty group → empty. Compliance uses scoreCompliance + isAtRisk.
 */
export async function resolveDeviceGroup(
  groupId: string,
): Promise<ResolveTargetsResult> {
  const group = await getDeviceGroup(groupId);
  if (!group) {
    console.warn(`[device-groups] missing group ${groupId}`);
    return { resolved: [], skippedNoIp: 0 };
  }
  return resolveDeviceGroupRules(group.rules);
}

/** Preview / resolve without a saved row (also used by create form preview). */
export async function resolveDeviceGroupRules(
  rawRules: DeviceGroupRules,
): Promise<ResolveTargetsResult> {
  const rules = normalizeDeviceGroupRules(rawRules);
  const conditions = [eq(assets.type, "Computer")];

  if (rules.locationId) {
    const subtree = await getSubtreeIds(rules.locationId);
    if (subtree.length === 0) return { resolved: [], skippedNoIp: 0 };
    conditions.push(inArray(assets.locationId, subtree));
  }

  if (rules.osContains) {
    conditions.push(
      ilike(machines.osName, `%${escapeLike(rules.osContains)}%`),
    );
  }

  const rows = await db
    .select({
      assetId: assets.id,
      tag: assets.tag,
      ip: computerDetails.ipAddress,
      bitlocker: complianceStatus.bitlocker,
      defenderRealtime: complianceStatus.defenderRealtime,
      defenderSigAgeDays: complianceStatus.defenderSigAgeDays,
      avProduct: complianceStatus.avProduct,
      tpmReady: complianceStatus.tpmReady,
      secureBoot: complianceStatus.secureBoot,
      updatesLastDays: complianceStatus.updatesLastDays,
      updatesPending: complianceStatus.updatesPending,
      systemDrivePctUsed: complianceStatus.systemDrivePctUsed,
      hasCompliance: complianceStatus.assetId,
    })
    .from(assets)
    .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
    .leftJoin(complianceStatus, eq(complianceStatus.assetId, assets.id))
    .leftJoin(machines, eq(machines.assetId, assets.id))
    .where(and(...conditions));

  const byAsset = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!byAsset.has(r.assetId)) byAsset.set(r.assetId, r);
  }
  const unique = [...byAsset.values()];

  const filtered =
    rules.compliance === "any"
      ? unique
      : unique.filter((r) => {
          if (!r.hasCompliance) return false;
          const posture: CompliancePosture = {
            bitlocker: r.bitlocker,
            defenderRealtime: r.defenderRealtime,
            defenderSigAgeDays: r.defenderSigAgeDays,
            avProduct: r.avProduct,
            tpmReady: r.tpmReady,
            secureBoot: r.secureBoot,
            updatesLastDays: r.updatesLastDays,
            updatesPending: r.updatesPending,
            systemDrivePctUsed: r.systemDrivePctUsed,
          };
          const score = scoreCompliance(posture);
          const atRisk = isAtRisk(score);
          return rules.compliance === "at-risk"
            ? atRisk
            : !atRisk && score.assessed;
        });

  return splitByIp(
    filtered.map((r) => ({ assetId: r.assetId, tag: r.tag, ip: r.ip })),
  );
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
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
