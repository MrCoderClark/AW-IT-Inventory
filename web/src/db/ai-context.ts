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
  notifications,
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

/** Notification body cap before egress. Keep the start; alerts lead with the fact. */
const NOTIFICATION_BODY_MAX = 2000;

export type NotificationContextPack = {
  notification: {
    type: string;
    severity: string;
    title: string;
    body: string;
  };
  asset: {
    tag: string;
    name: string;
    type: string;
    locationPath: string | null;
  } | null;
};

/** Redacted context for drafting a ticket from one notification. Null if missing. */
export async function buildNotificationContextPack(
  notificationId: string,
): Promise<NotificationContextPack | null> {
  const [row] = await db
    .select({
      type: notifications.type,
      severity: notifications.severity,
      title: notifications.title,
      body: notifications.body,
      tag: assets.tag,
      name: assets.name,
      assetType: assets.type,
      locationName: locations.name,
    })
    .from(notifications)
    .leftJoin(assets, eq(assets.id, notifications.assetId))
    .leftJoin(locations, eq(locations.id, assets.locationId))
    .where(eq(notifications.id, notificationId))
    .limit(1);
  if (!row) return null;

  const pack: NotificationContextPack = {
    notification: {
      type: String(row.type),
      severity: String(row.severity),
      title: row.title,
      body:
        row.body.length <= NOTIFICATION_BODY_MAX
          ? row.body
          : row.body.slice(0, NOTIFICATION_BODY_MAX),
    },
    asset: row.tag
      ? {
          tag: row.tag,
          name: row.name ?? "",
          type: String(row.assetType ?? ""),
          locationPath: row.locationName ?? null,
        }
      : null,
  };

  return redactDeep(pack);
}
