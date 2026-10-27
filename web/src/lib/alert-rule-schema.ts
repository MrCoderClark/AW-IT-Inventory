import { z } from "zod";

import type {
  AlertSeverity,
  MetricOp,
  MetricSignal,
  TicketAutoCreateMode,
} from "@/lib/alert-rules";

/**
 * Alert-rule form schema (spec 30, AC-1). Parsed on the client for inline field
 * errors and re-parsed in each Server Action (the trust boundary). Threshold and
 * consecutive accept a string from `<input type="number">` or a number.
 */

export const METRIC_SIGNALS = [
  "cpu_pct",
  "mem_pct",
  "disk_pct",
  "uptime_sec",
] as const satisfies readonly MetricSignal[];

export const METRIC_OPS = ["gt", "gte", "lt", "lte"] as const satisfies readonly MetricOp[];

export const ALERT_SEVERITIES = [
  "info",
  "warning",
  "critical",
] as const satisfies readonly AlertSeverity[];

export const TICKET_AUTO_CREATE_MODES = [
  "inherit",
  "on",
  "off",
] as const satisfies readonly TicketAutoCreateMode[];

function finiteNumber(label: string, min?: number, max?: number) {
  let schema = z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === "number" ? v : Number(String(v).trim())))
    .refine((v) => Number.isFinite(v), `${label} must be a number`);
  if (min !== undefined) {
    const floor = min;
    schema = schema.refine((v) => v >= floor, `${label} must be at least ${floor}`);
  }
  if (max !== undefined) {
    const ceil = max;
    schema = schema.refine((v) => v <= ceil, `${label} must be at most ${ceil}`);
  }
  return schema;
}

export const alertRuleInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(80, "Name is too long (max 80 characters)"),
  signal: z.enum(METRIC_SIGNALS, { error: "Choose a signal" }),
  op: z.enum(METRIC_OPS, { error: "Choose an operator" }),
  threshold: finiteNumber("Threshold"),
  consecutive: finiteNumber("Consecutive samples", 1, 48).transform((v) =>
    Math.floor(v),
  ),
  severity: z.enum(ALERT_SEVERITIES, { error: "Choose a severity" }),
  ticketAutoCreate: z.enum(TICKET_AUTO_CREATE_MODES, {
    error: "Choose ticket auto-create",
  }),
  /** Empty string or null clears remediation; otherwise an active script UUID. */
  remediationScriptId: z
    .union([z.literal(""), z.null(), z.string().uuid("Choose a valid script")])
    .optional()
    .transform((v) => (!v ? null : v)),
  /** Empty string or null = fleet-wide; otherwise a device-group UUID. */
  deviceGroupId: z
    .union([z.literal(""), z.null(), z.string().uuid("Choose a valid group")])
    .optional()
    .transform((v) => (!v ? null : v)),
});

export type AlertRuleInput = z.output<typeof alertRuleInputSchema>;

export interface AlertRuleFormValues {
  name: string;
  signal: MetricSignal;
  op: MetricOp;
  threshold: string;
  consecutive: string;
  severity: AlertSeverity;
  ticketAutoCreate: TicketAutoCreateMode;
  /** Form value: "" means none. */
  remediationScriptId: string;
  /** Form value: "" means all computers. */
  deviceGroupId: string;
}

export const EMPTY_ALERT_RULE_FORM: AlertRuleFormValues = {
  name: "",
  signal: "cpu_pct",
  op: "gte",
  threshold: "90",
  consecutive: "1",
  severity: "warning",
  ticketAutoCreate: "inherit",
  remediationScriptId: "",
  deviceGroupId: "",
};

export function fieldErrors<T extends string>(
  error: z.ZodError,
): Partial<Record<T, string>> {
  const out: Partial<Record<T, string>> = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as T | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export function firstAlertRuleError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input isn't valid.";
}
