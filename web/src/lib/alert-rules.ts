/**
 * Metric-threshold alert evaluator (spec 30). Pure and client-safe: the ingest
 * hook and the admin UI both describe a rule the same way, and the consecutive-
 * sample machine is unit-tested without the DB. Duration is consecutive readable
 * samples, not wall-clock minutes (AC-8). A null gauge is a gap (AC-4): skip the
 * tick, leave the streak alone — never treat missing data as 0.
 */

export type MetricSignal = "cpu_pct" | "mem_pct" | "disk_pct" | "uptime_sec";
export type MetricOp = "gt" | "gte" | "lt" | "lte";
export type AlertSeverity = "info" | "warning" | "critical";
export type TicketAutoCreateMode = "inherit" | "on" | "off";

export interface MetricRule {
  signal: MetricSignal;
  op: MetricOp;
  threshold: number;
  consecutive: number;
}

export type TickVerdict = "firing" | "ok" | "skip";

export interface TickResult {
  consecutive: number;
  verdict: TickVerdict;
}

export const SIGNAL_LABEL: Record<MetricSignal, string> = {
  cpu_pct: "CPU",
  mem_pct: "Memory",
  disk_pct: "Disk",
  uptime_sec: "Uptime",
};

export const OP_LABEL: Record<MetricOp, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

export const TICKET_AUTO_CREATE_LABEL: Record<TicketAutoCreateMode, string> = {
  inherit: "Inherit",
  on: "On",
  off: "Off",
};

/** One `alert_rules` row, safe to pass into the admin table/dialog. */
export interface AlertRuleRecord {
  id: string;
  name: string;
  signal: MetricSignal;
  op: MetricOp;
  threshold: number;
  consecutive: number;
  severity: AlertSeverity;
  enabled: boolean;
  ticketAutoCreate: TicketAutoCreateMode;
  /** Null = no remediation script on fire (spec 32 on-alert). */
  remediationScriptId: string | null;
  /** Display name when the FK resolves; null if unset or script missing. */
  remediationScriptName: string | null;
  /** Null = fleet-wide; otherwise only computers in this device group. */
  deviceGroupId: string | null;
  /** Display name when the FK resolves; null if unset or group missing. */
  deviceGroupName: string | null;
}

export function matchesThreshold(
  value: number,
  op: MetricOp,
  threshold: number,
): boolean {
  switch (op) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

/** Needed consecutive samples; a missing or non-positive value is 1. */
export function ruleWindow(consecutive: number): number {
  return Number.isFinite(consecutive) && consecutive >= 1
    ? Math.floor(consecutive)
    : 1;
}

/**
 * Apply one readable-or-gap sample to a rule's streak. `prevConsecutive` is the
 * persisted streak from `alert_rule_states`.
 */
export interface MetricGauges {
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
  uptimeSec: number | null;
}

export function gaugeOf(sample: MetricGauges, signal: MetricSignal): number | null {
  switch (signal) {
    case "cpu_pct":
      return sample.cpuPct;
    case "mem_pct":
      return sample.memPct;
    case "disk_pct":
      return sample.diskPct;
    case "uptime_sec":
      return sample.uptimeSec;
  }
}

export type AlertedState = "ok" | "firing";
export type EpisodeAction = "fire" | "recover" | "hold";

/** Decide whether this tick should notify, given the last *notified* state. */
export function episodeAction(
  prev: AlertedState | null,
  verdict: TickVerdict,
): EpisodeAction {
  if (verdict === "skip") return "hold";
  if (verdict === "firing" && prev !== "firing") return "fire";
  if (verdict === "ok" && prev === "firing") return "recover";
  return "hold";
}

export function applyMetricTick(
  prevConsecutive: number,
  value: number | null,
  rule: MetricRule,
): TickResult {
  if (value === null || !Number.isFinite(value)) {
    return { consecutive: prevConsecutive, verdict: "skip" };
  }
  const need = ruleWindow(rule.consecutive);
  if (!matchesThreshold(value, rule.op, rule.threshold)) {
    return { consecutive: 0, verdict: "ok" };
  }
  const consecutive = prevConsecutive + 1;
  return {
    consecutive,
    verdict: consecutive >= need ? "firing" : "ok",
  };
}

export function formatCondition(rule: MetricRule, cadenceMinutes = 15): string {
  const need = ruleWindow(rule.consecutive);
  const approx = need * cadenceMinutes;
  const unit = rule.signal === "uptime_sec" ? "s" : "%";
  const samples =
    need === 1
      ? `1 sample (~${approx} min)`
      : `${need} samples (~${approx} min)`;
  return `${SIGNAL_LABEL[rule.signal]} ${OP_LABEL[rule.op]} ${rule.threshold}${unit} for ${samples}`;
}
