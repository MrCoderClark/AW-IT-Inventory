"use server";

import { revalidatePath } from "next/cache";

import { getActiveRemediationScript } from "@/db/alert-rule-remediation";
import {
  createAlertRule,
  deleteAlertRule,
  setAlertRuleEnabled,
  updateAlertRule,
} from "@/db/alert-rules";
import {
  alertRuleInputSchema,
  firstAlertRuleError,
} from "@/lib/alert-rule-schema";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to manage alert rules.",
};

function revalidate() {
  revalidatePath("/admin");
  revalidatePath("/admin/alert-rules");
}

async function rejectInactiveScript(
  scriptId: string | null | undefined,
): Promise<ActionResult | null> {
  if (!scriptId) return null;
  const active = await getActiveRemediationScript(scriptId);
  if (!active) {
    return {
      ok: false,
      error: "Choose an active script from the library (archived scripts aren't allowed).",
    };
  }
  return null;
}

/**
 * Create / edit / enable / delete metric-threshold rules (spec 30, AC-1).
 * Gated on `user:admin` and rechecked here so a viewer can't call the actions
 * even if they spoof the form. No new RBAC permission — same as Users.
 */
export async function createAlertRuleAction(
  input: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  const parsed = alertRuleInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstAlertRuleError(parsed.error) };
  }

  const badScript = await rejectInactiveScript(parsed.data.remediationScriptId);
  if (badScript) return badScript;

  const row = await createAlertRule(parsed.data);
  revalidate();
  return { ok: true, message: `Created "${row.name}".` };
}

export async function updateAlertRuleAction(
  id: unknown,
  input: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown alert rule." };
  }

  const parsed = alertRuleInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstAlertRuleError(parsed.error) };
  }

  const badScript = await rejectInactiveScript(parsed.data.remediationScriptId);
  if (badScript) return badScript;

  const row = await updateAlertRule(id, parsed.data);
  if (!row) return { ok: false, error: "That rule is no longer there." };
  revalidate();
  return { ok: true, message: `Updated "${row.name}".` };
}

export async function deleteAlertRuleAction(
  id: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown alert rule." };
  }

  const removed = await deleteAlertRule(id);
  if (!removed) return { ok: false, error: "That rule is no longer there." };
  revalidate();
  return { ok: true, message: "Deleted that rule." };
}

export async function setAlertRuleEnabledAction(
  id: unknown,
  enabled: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "user:admin")) return FORBIDDEN;

  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown alert rule." };
  }
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "Choose on or off." };
  }

  const row = await setAlertRuleEnabled(id, enabled);
  if (!row) return { ok: false, error: "That rule is no longer there." };
  revalidate();
  return {
    ok: true,
    message: enabled ? `Enabled "${row.name}".` : `Disabled "${row.name}".`,
  };
}
