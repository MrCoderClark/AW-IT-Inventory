import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "./index";
import { alertRules, alertRuleStates, assets } from "./schema";
import { createNotification } from "./notifications";
import type { MetricSample } from "./metrics";
import type { AlertRuleInput } from "@/lib/alert-rule-schema";
import { sendAlertRuleEmail } from "@/lib/notify";
import {
  applyMetricTick,
  episodeAction,
  formatCondition,
  gaugeOf,
  SIGNAL_LABEL,
  type AlertRuleRecord,
  type MetricOp,
  type MetricRule,
  type MetricSignal,
} from "@/lib/alert-rules";

/**
 * Metric-threshold alerts (spec 30). Evaluated as a best-effort side effect of
 * metric ingest. Default rules are inserted once (stable ids, on-conflict
 * do-nothing) so an admin disable survives deploys. Episode state advances only
 * after a successful in-app notification write.
 */

/** Stable ids so re-seed never duplicates or re-enables a disabled default. */
export const DEFAULT_ALERT_RULES = [
  {
    id: "a3000000-0000-4000-8000-000000000001",
    name: "CPU high",
    signal: "cpu_pct" as const,
    op: "gte" as const,
    threshold: 90,
    consecutive: 2,
    severity: "warning" as const,
    enabled: true,
  },
  {
    id: "a3000000-0000-4000-8000-000000000002",
    name: "Memory high",
    signal: "mem_pct" as const,
    op: "gte" as const,
    threshold: 90,
    consecutive: 2,
    severity: "warning" as const,
    enabled: true,
  },
  {
    id: "a3000000-0000-4000-8000-000000000003",
    name: "Disk almost full",
    signal: "disk_pct" as const,
    op: "gte" as const,
    threshold: 90,
    consecutive: 1,
    severity: "critical" as const,
    enabled: true,
  },
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRecord(row: {
  id: string;
  name: string;
  signal: MetricSignal;
  op: MetricOp;
  threshold: number;
  consecutive: number;
  severity: AlertRuleRecord["severity"];
  enabled: boolean;
  ticketAutoCreate: AlertRuleRecord["ticketAutoCreate"];
}): AlertRuleRecord {
  return {
    id: row.id,
    name: row.name,
    signal: row.signal,
    op: row.op,
    threshold: row.threshold,
    consecutive: row.consecutive,
    severity: row.severity,
    enabled: row.enabled,
    ticketAutoCreate: row.ticketAutoCreate,
  };
}

/** Insert the three defaults only when the table is empty, so an admin delete
    or disable survives the next ingest (AC-7). */
export async function seedDefaultAlertRules(): Promise<void> {
  const existing = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(alertRules).values(DEFAULT_ALERT_RULES);
}

/** Every rule, including disabled ones, for the admin table (AC-1). Seeds the
    three defaults the first time an admin opens the page. */
export async function listAlertRules(): Promise<AlertRuleRecord[]> {
  await seedDefaultAlertRules();
  const rows = await db
    .select()
    .from(alertRules)
    .orderBy(asc(alertRules.name));
  return rows.map(toRecord);
}

export async function createAlertRule(
  input: AlertRuleInput,
): Promise<AlertRuleRecord> {
  const [row] = await db
    .insert(alertRules)
    .values({
      name: input.name,
      signal: input.signal,
      op: input.op,
      threshold: input.threshold,
      consecutive: input.consecutive,
      severity: input.severity,
      ticketAutoCreate: input.ticketAutoCreate,
      enabled: true,
    })
    .returning();
  if (!row) throw new Error("Failed to create alert rule");
  return toRecord(row);
}

export async function updateAlertRule(
  id: string,
  input: AlertRuleInput,
): Promise<AlertRuleRecord | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .update(alertRules)
    .set({
      name: input.name,
      signal: input.signal,
      op: input.op,
      threshold: input.threshold,
      consecutive: input.consecutive,
      severity: input.severity,
      ticketAutoCreate: input.ticketAutoCreate,
      updatedAt: new Date(),
    })
    .where(eq(alertRules.id, id))
    .returning();
  return row ? toRecord(row) : null;
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const deleted = await db
    .delete(alertRules)
    .where(eq(alertRules.id, id))
    .returning({ id: alertRules.id });
  return deleted.length > 0;
}

export async function setAlertRuleEnabled(
  id: string,
  enabled: boolean,
): Promise<AlertRuleRecord | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .update(alertRules)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(alertRules.id, id))
    .returning();
  return row ? toRecord(row) : null;
}

function latestByAsset(samples: MetricSample[]): Map<string, MetricSample> {
  const map = new Map<string, MetricSample>();
  for (const s of samples) {
    const prev = map.get(s.assetId);
    if (!prev || s.sampledAt > prev.sampledAt) map.set(s.assetId, s);
  }
  return map;
}

function asSpec(rule: {
  signal: MetricSignal;
  op: MetricOp;
  threshold: number;
  consecutive: number;
}): MetricRule {
  return {
    signal: rule.signal,
    op: rule.op,
    threshold: rule.threshold,
    consecutive: rule.consecutive,
  };
}

/**
 * Evaluate every enabled rule against the latest sample per asset in this batch
 * (AC-2). Must never throw to the ingest caller — wrap at the route. A gap
 * (null gauge) skips the tick (AC-4).
 */
export async function evaluateMetricAlerts(
  samples: MetricSample[],
): Promise<void> {
  if (samples.length === 0) return;
  await seedDefaultAlertRules();

  const rules = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.enabled, true));
  if (rules.length === 0) return;

  const byAsset = latestByAsset(samples);
  const assetIds = [...byAsset.keys()];
  const assetRows = await db
    .select({ id: assets.id, tag: assets.tag, name: assets.name })
    .from(assets)
    .where(inArray(assets.id, assetIds));
  const assetById = new Map(assetRows.map((a) => [a.id, a]));

  const stateRows = await db
    .select()
    .from(alertRuleStates)
    .where(
      and(
        inArray(
          alertRuleStates.ruleId,
          rules.map((r) => r.id),
        ),
        inArray(alertRuleStates.assetId, assetIds),
      ),
    );
  const stateOf = (ruleId: string, assetId: string) =>
    stateRows.find((s) => s.ruleId === ruleId && s.assetId === assetId);

  const now = new Date();
  for (const rule of rules) {
    const spec = asSpec(rule);
    for (const [assetId, sample] of byAsset) {
      const asset = assetById.get(assetId);
      if (!asset) continue;
      try {
        const prev = stateOf(rule.id, assetId);
        const value = gaugeOf(sample, rule.signal);
        const tick = applyMetricTick(prev?.consecutive ?? 0, value, spec);
        if (tick.verdict === "skip") continue;

        const action = episodeAction(prev?.alertedState ?? null, tick.verdict);
        let nextAlerted = prev?.alertedState ?? null;
        if (action === "fire" || action === "recover") {
          const unit = rule.signal === "uptime_sec" ? "s" : "%";
          const valueText =
            value === null ? "n/a" : `${Math.round(value)}${unit}`;
          const fired = action === "fire";
          const id = await createNotification({
            type: fired ? "metric-threshold" : "metric-recovered",
            severity: fired ? rule.severity : "info",
            title: fired
              ? `${asset.name}: ${rule.name}`
              : `${asset.name}: ${rule.name} recovered`,
            body: fired
              ? `${SIGNAL_LABEL[rule.signal]} ${valueText} (${formatCondition(spec)})`
              : `${SIGNAL_LABEL[rule.signal]} is back under the threshold.`,
            href: `/assets/${asset.tag}`,
            dedupeKey: fired
              ? `metric-threshold-${rule.id}-${assetId}-${now.toISOString()}`
              : `metric-recovered-${rule.id}-${assetId}-${now.toISOString()}`,
            assetId,
            meta: { alertRuleId: rule.id },
          });
          if (id) {
            nextAlerted = fired ? "firing" : "ok";
            // Best-effort email, non-gating (AC-6): the in-app write above is
            // the durable record. A failed send is logged inside notify.
            await sendAlertRuleEmail({
              computer: { name: asset.name, tag: asset.tag },
              event: fired ? "firing" : "recovered",
              rule: {
                name: rule.name,
                condition: formatCondition(spec),
                severity: rule.severity,
              },
              value: valueText,
            });
          }
        } else if (tick.verdict === "ok" && nextAlerted === null) {
          nextAlerted = "ok";
        }

        await db
          .insert(alertRuleStates)
          .values({
            ruleId: rule.id,
            assetId,
            consecutive: tick.consecutive,
            alertedState: nextAlerted,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [alertRuleStates.ruleId, alertRuleStates.assetId],
            set: {
              consecutive: tick.consecutive,
              alertedState: nextAlerted,
              updatedAt: now,
            },
          });
      } catch (err) {
        console.error(
          `[alert-rules] evaluate failed for rule ${rule.id} asset ${assetId}:`,
          err,
        );
      }
    }
  }
}
