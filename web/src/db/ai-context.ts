import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getComplianceStatus } from "./compliance";
import { getDeviceMetrics } from "./metrics";
import { listScriptRunsForAssetTag } from "./script-runs";
import { listDeploymentsForAssetTag } from "./software-deploy";
import { listPatchInstallsForAssetTag } from "./patch-install";
import { db } from "./index";
import {
  alertRules,
  alertRuleStates,
  assets,
  computerDetails,
  locations,
} from "./schema";
import { redactDeep } from "@/lib/ai/redact";

export type ComputerContextPack = {
  asset: {
    tag: string;
    name: string;
    type: string;
    locationPath: string | null;
    hasIp: boolean;
  };
  compliance: unknown;
  metricsLatest: unknown;
  firingAlerts: Array<{ rule: string; signal: string; severity: string }>;
  recentScriptRuns: unknown[];
  recentPatchJobs: unknown[];
  recentDeploys: unknown[];
};

/** Build a redacted, size-capped context pack for one Computer (by human tag). */
export async function buildComputerContextPack(
  tag: string,
): Promise<ComputerContextPack | null> {
  const [row] = await db
    .select({
      id: assets.id,
      tag: assets.tag,
      name: assets.name,
      type: assets.type,
      locationId: assets.locationId,
      ip: computerDetails.ipAddress,
    })
    .from(assets)
    .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
    .where(and(eq(assets.tag, tag), eq(assets.type, "Computer")))
    .limit(1);
  if (!row) return null;

  let locationPath: string | null = null;
  if (row.locationId) {
    const [loc] = await db
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, row.locationId))
      .limit(1);
    locationPath = loc?.name ?? null;
  }

  const [compliance, metrics, firing, scripts, patches, deploys] =
    await Promise.all([
      getComplianceStatus(tag),
      getDeviceMetrics(tag, 24),
      db
        .select({
          rule: alertRules.name,
          signal: alertRules.signal,
          severity: alertRules.severity,
        })
        .from(alertRuleStates)
        .innerJoin(alertRules, eq(alertRules.id, alertRuleStates.ruleId))
        .where(
          and(
            eq(alertRuleStates.assetId, row.id),
            eq(alertRuleStates.alertedState, "firing"),
          ),
        ),
      listScriptRunsForAssetTag(tag, 5),
      listPatchInstallsForAssetTag(tag, 5),
      listDeploymentsForAssetTag(tag, 5),
    ]);

  const pack: ComputerContextPack = {
    asset: {
      tag: row.tag,
      name: row.name,
      type: row.type,
      locationPath,
      hasIp: Boolean(row.ip),
    },
    compliance: compliance
      ? {
          bitlocker: compliance.bitlocker,
          defenderRealtime: compliance.defenderRealtime,
          defenderSigAgeDays: compliance.defenderSigAgeDays,
          avProduct: compliance.avProduct,
          tpmReady: compliance.tpmReady,
          secureBoot: compliance.secureBoot,
          updatesPending: compliance.updatesPending,
          systemDrivePctUsed: compliance.systemDrivePctUsed,
          assessedAt: compliance.assessedAt,
          // omit localAdmins (can be sensitive)
        }
      : null,
    metricsLatest: metrics.latest
      ? {
          cpuPct: metrics.latest.cpuPct,
          memPct: metrics.latest.memPct,
          diskPct: metrics.latest.diskPct,
          uptimeSec: metrics.latest.uptimeSec,
          sampledAt: metrics.latest.sampledAt,
        }
      : null,
    firingAlerts: firing.map((f) => ({
      rule: f.rule,
      signal: String(f.signal),
      severity: String(f.severity),
    })),
    recentScriptRuns: scripts.map((s) => ({
      scriptName: s.scriptName,
      status: s.status,
      exitCode: s.result?.exitCode ?? null,
      outputTail: truncate(s.result?.outputTail ?? s.error, 800),
      requestedAt: s.requestedAt,
    })),
    recentPatchJobs: patches.map((p) => ({
      id: p.id,
      status: p.status,
      osCount: p.osCount,
      appCount: p.appCount,
      requestedAt: p.requestedAt,
      error: p.error,
    })),
    recentDeploys: deploys.map((d) => ({
      id: d.id,
      status: d.status,
      packageName: d.packageName,
      requestedAt: d.requestedAt,
      error: d.error,
    })),
  };

  return redactDeep(pack);
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length <= n ? s : `…${s.slice(-n)}`;
}
