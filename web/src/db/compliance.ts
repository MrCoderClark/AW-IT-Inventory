import "server-only";

import { eq } from "drizzle-orm";

import { db } from "./index";
import { createNotification } from "./notifications";
import { sendComplianceAlertEmail } from "@/lib/notify";
import { assets, complianceStatus } from "./schema";
import {
  failingSecurityChecks,
  scoreCompliance,
  type CompliancePosture,
  type LocalAdmin,
} from "@/lib/compliance-score";

/** Normalize the stored `localAdmins` jsonb, tolerating the pre-v2 shape (a plain
   string[]) alongside the current {name, isGroup}[] until rows are re-scanned. */
function normalizeAdmins(v: unknown): LocalAdmin[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map((e) =>
    typeof e === "string"
      ? { name: e, isGroup: false, enabled: true }
      : {
          name: String((e as { name?: unknown })?.name ?? ""),
          isGroup: Boolean((e as { isGroup?: unknown })?.isGroup),
          // Older rows have no `enabled` → treat as enabled.
          enabled: (e as { enabled?: unknown })?.enabled !== false,
        },
  );
  return out.filter((a) => a.name);
}

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
  local_admins?:
    | { name?: string | null; is_group?: boolean | null; enabled?: boolean | null }[]
    | null;
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
    // Store camelCase {name, isGroup}; drop entries with no name.
    localAdmins: posted.local_admins
      ? posted.local_admins
          .map((a) => ({
            name: a.name ?? "",
            isGroup: Boolean(a.is_group),
            enabled: a.enabled !== false,
          }))
          .filter((a) => a.name)
      : null,
    assessedAt,
  };
  const { assetId: _pk, ...set } = row;
  await db
    .insert(complianceStatus)
    .values(row)
    .onConflictDoUpdate({ target: complianceStatus.assetId, set });
}

/**
 * Alert admins when a computer's security posture crosses a boundary (spec 21 v2):
 * a transition into "at-risk" (any hard security check — BitLocker/AV/Secure
 * Boot/TPM — failing) fires one notification, and the return to clean fires a
 * recovery notice. Modeled on the printer-reachability alert (spec 12): the last
 * notified state lives in `compliance_status.alertedState` and is advanced **only
 * after a successful send**, so a failed notification is retried next scan and we
 * never spam while a device stays at-risk (one alert per episode, one recovery).
 *
 * Call AFTER `upsertComplianceStatus` (which doesn't touch `alertedState`), keyed
 * by the asset's uuid. Best-effort by the caller (ingest) — must never fail the
 * machine ingest. A device that isn't assessed (posture unreadable) never alerts.
 */
export async function evaluateComplianceAlert(
  assetId: string,
  assessedAt: Date,
): Promise<void> {
  const [r] = await db
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
      alertedState: complianceStatus.alertedState,
    })
    .from(complianceStatus)
    .innerJoin(assets, eq(assets.id, complianceStatus.assetId))
    .where(eq(complianceStatus.assetId, assetId))
    .limit(1);
  if (!r) return;

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
  // A device we can't assess (all-unknown) doesn't get an alert state at all —
  // leave the prior state untouched so a real reading later still transitions.
  if (!score.assessed) return;

  const failing = failingSecurityChecks(score);
  const newState: "ok" | "at-risk" = failing.length ? "at-risk" : "ok";
  const prev = r.alertedState ?? null;
  if (prev === newState) return; // no boundary crossed

  const href = `/assets/${r.tag}`;
  const stamp = assessedAt.toISOString();

  if (newState === "at-risk") {
    const id = await createNotification({
      type: "compliance-at-risk",
      severity: "warning",
      title: `${r.name} failed a security check`,
      body: failing.map((c) => `${c.label}: ${c.detail}`).join(" · "),
      href,
      // Unique per scan, so a later episode isn't swallowed by idempotency; the
      // transition gate already ensures we only call this once per onset.
      dedupeKey: `compliance-at-risk-${assetId}-${stamp}`,
      assetId,
    });
    // Advance only on a confirmed insert (null = send failed → retry next scan).
    if (id) {
      await setAlertedState(assetId, "at-risk");
      // Best-effort email, non-gating: the in-app alert above is the durable
      // record and already gates re-firing, so a failed email just logs.
      await sendComplianceAlertEmail({
        computer: { name: r.name, tag: r.tag },
        event: "at-risk",
        checks: failing.map((c) => ({ label: c.label, detail: c.detail })),
      });
    }
    return;
  }

  // Recovered. Only announce a recovery if we'd actually alerted (prev at-risk);
  // a first-ever clean reading just records "ok" silently.
  if (prev === "at-risk") {
    const id = await createNotification({
      type: "compliance-recovered",
      severity: "info",
      title: `${r.name} is back in compliance`,
      body: "All hard security checks (BitLocker, antivirus, Secure Boot, TPM) pass.",
      href,
      dedupeKey: `compliance-recovered-${assetId}-${stamp}`,
      assetId,
    });
    if (id) {
      await setAlertedState(assetId, "ok");
      await sendComplianceAlertEmail({
        computer: { name: r.name, tag: r.tag },
        event: "recovered",
        checks: [],
      });
    }
    return;
  }
  await setAlertedState(assetId, "ok");
}

async function setAlertedState(
  assetId: string,
  state: "ok" | "at-risk",
): Promise<void> {
  await db
    .update(complianceStatus)
    .set({ alertedState: state })
    .where(eq(complianceStatus.assetId, assetId));
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
    localAdmins: normalizeAdmins(r.localAdmins),
    assessedAt: r.assessedAt.toISOString(),
  };
}
