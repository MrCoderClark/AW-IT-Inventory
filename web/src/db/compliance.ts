import "server-only";

import { eq } from "drizzle-orm";

import { db } from "./index";
import { assets, complianceStatus } from "./schema";
import type { CompliancePosture } from "@/lib/compliance-score";

/* ================================================================
   Compliance posture storage (spec 21). One current-state row per
   Computer asset (no history), upserted at ingest. The health score
   and verdicts are derived at read time by `scoreCompliance`
   (src/lib/compliance-score.ts) — nothing scored is stored here.
   ================================================================ */

/** Loose shape of the collector's `compliance` block in the ingest payload
   (snake_case, matching `models.Compliance`). Every field is optional/nullable:
   a signal the collector couldn't read arrives as null ("unknown"). */
export interface PostedCompliance {
  bitlocker?: string | null;
  defender_realtime?: boolean | null;
  defender_sig_age_days?: number | null;
  av_product?: string | null;
  tpm_ready?: boolean | null;
  secure_boot?: string | null;
  updates_last_days?: number | null;
  updates_pending?: number | null;
  system_drive_pct_used?: number | null;
  local_admins?: string[] | null;
}

/**
 * Upsert a Computer asset's current posture (one row per asset; a new scan
 * replaces it). Best-effort by the caller (ingest) — a failure here must never
 * fail the machine ingest, and an absent `compliance` block leaves the prior row
 * intact (the caller skips this when the collector returned nothing).
 */
export async function upsertComplianceStatus(
  assetId: string,
  posted: PostedCompliance,
  assessedAt: Date,
): Promise<void> {
  const row = {
    assetId,
    bitlocker: posted.bitlocker ?? null,
    defenderRealtime: posted.defender_realtime ?? null,
    defenderSigAgeDays: posted.defender_sig_age_days ?? null,
    avProduct: posted.av_product ?? null,
    tpmReady: posted.tpm_ready ?? null,
    secureBoot: posted.secure_boot ?? null,
    updatesLastDays: posted.updates_last_days ?? null,
    updatesPending: posted.updates_pending ?? null,
    systemDrivePctUsed: posted.system_drive_pct_used ?? null,
    localAdmins: posted.local_admins ?? null,
    assessedAt,
  };
  const { assetId: _pk, ...set } = row;
  await db
    .insert(complianceStatus)
    .values(row)
    .onConflictDoUpdate({ target: complianceStatus.assetId, set });
}

export interface FleetComplianceRow {
  tag: string;
  name: string;
  posture: CompliancePosture | null; // null = never assessed
}

/** Every Computer asset with its current posture (null when never scanned for it),
   for the /compliance fleet dashboard (spec 21 phase 3). The caller scores each via
   `scoreCompliance`. Ordered by name. */
export async function getFleetCompliance(): Promise<FleetComplianceRow[]> {
  const rows = await db
    .select({
      tag: assets.tag,
      name: assets.name,
      bitlocker: complianceStatus.bitlocker,
      defenderRealtime: complianceStatus.defenderRealtime,
      defenderSigAgeDays: complianceStatus.defenderSigAgeDays,
      avProduct: complianceStatus.avProduct,
      tpmReady: complianceStatus.tpmReady,
      secureBoot: complianceStatus.secureBoot,
      updatesLastDays: complianceStatus.updatesLastDays,
      updatesPending: complianceStatus.updatesPending,
      systemDrivePctUsed: complianceStatus.systemDrivePctUsed,
      assessedAt: complianceStatus.assessedAt,
    })
    .from(assets)
    .leftJoin(complianceStatus, eq(complianceStatus.assetId, assets.id))
    .where(eq(assets.type, "Computer"))
    .orderBy(assets.name);

  return rows.map((r) => ({
    tag: r.tag,
    name: r.name,
    // assessedAt is only set when a posture row exists (left join).
    posture: r.assessedAt
      ? {
          bitlocker: r.bitlocker,
          defenderRealtime: r.defenderRealtime,
          defenderSigAgeDays: r.defenderSigAgeDays,
          avProduct: r.avProduct,
          tpmReady: r.tpmReady,
          secureBoot: r.secureBoot,
          updatesLastDays: r.updatesLastDays,
          updatesPending: r.updatesPending,
          systemDrivePctUsed: r.systemDrivePctUsed,
          assessedAt: r.assessedAt.toISOString(),
        }
      : null,
  }));
}

/** The stored posture for one asset, looked up by its human **tag** (the public
   id the UI holds; `compliance_status.assetId` is the uuid FK, resolved via a join
   — same pattern as `getInstalledSoftware`). Null if never assessed. Pass the
   result to `scoreCompliance` for the score + verdicts. */
export async function getComplianceStatus(
  tag: string,
): Promise<CompliancePosture | null> {
  const [r] = await db
    .select({
      bitlocker: complianceStatus.bitlocker,
      defenderRealtime: complianceStatus.defenderRealtime,
      defenderSigAgeDays: complianceStatus.defenderSigAgeDays,
      avProduct: complianceStatus.avProduct,
      tpmReady: complianceStatus.tpmReady,
      secureBoot: complianceStatus.secureBoot,
      updatesLastDays: complianceStatus.updatesLastDays,
      updatesPending: complianceStatus.updatesPending,
      systemDrivePctUsed: complianceStatus.systemDrivePctUsed,
      localAdmins: complianceStatus.localAdmins,
      assessedAt: complianceStatus.assessedAt,
    })
    .from(complianceStatus)
    .innerJoin(assets, eq(assets.id, complianceStatus.assetId))
    .where(eq(assets.tag, tag))
    .limit(1);
  if (!r) return null;
  return {
    bitlocker: r.bitlocker,
    defenderRealtime: r.defenderRealtime,
    defenderSigAgeDays: r.defenderSigAgeDays,
    avProduct: r.avProduct,
    tpmReady: r.tpmReady,
    secureBoot: r.secureBoot,
    updatesLastDays: r.updatesLastDays,
    updatesPending: r.updatesPending,
    systemDrivePctUsed: r.systemDrivePctUsed,
    localAdmins: r.localAdmins ?? null,
    assessedAt: r.assessedAt.toISOString(),
  };
}
