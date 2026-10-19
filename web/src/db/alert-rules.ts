import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "./index";
import { alertRules, alertRuleStates, assets } from "./schema";
import { createNotification } from "./notifications";
import type { MetricSample } from "./metrics";
import {
  applyMetricTick,
  episodeAction,
  formatCondition,
  gaugeOf,
  SIGNAL_LABEL,
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

export async function seedDefaultAlertRules(): Promise<void> {
  await db.insert(alertRules).values(DEFAULT_ALERT_RULES).onConflictDoNothing();
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
          });
          if (id) nextAlerted = fired ? "firing" : "ok";
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
