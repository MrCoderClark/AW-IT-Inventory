import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "./index";
import { scripts } from "./schema";
import { enqueueScriptRun, resolveDeployTarget } from "./script-runs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Active (non-archived) script or null. Used when saving a remediation link. */
export async function getActiveRemediationScript(
  id: string,
): Promise<{ id: string; name: string; body: string; timeoutSeconds: number } | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select({
      id: scripts.id,
      name: scripts.name,
      body: scripts.body,
      timeoutSeconds: scripts.timeoutSeconds,
      archivedAt: scripts.archivedAt,
    })
    .from(scripts)
    .where(and(eq(scripts.id, id), isNull(scripts.archivedAt)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    timeoutSeconds: row.timeoutSeconds,
  };
}

/**
 * Best-effort Spec 32 remediation on fire. Never throws to the caller.
 * Skips missing/archived script, no IP, or already-inflight.
 */
export async function maybeEnqueueAlertRemediation(input: {
  ruleId: string;
  remediationScriptId: string | null | undefined;
  assetTag: string;
}): Promise<void> {
  const scriptId = input.remediationScriptId;
  if (!scriptId) return;
  try {
    const script = await getActiveRemediationScript(scriptId);
    if (!script) {
      console.warn(
        `[alert-rules] remediation script ${scriptId} missing/archived for rule ${input.ruleId}`,
      );
      return;
    }
    const target = await resolveDeployTarget(input.assetTag);
    if (!target) {
      console.warn(
        `[alert-rules] no IP for ${input.assetTag}; skip remediation on rule ${input.ruleId}`,
      );
      return;
    }
    const result = await enqueueScriptRun({
      assetId: target.assetId,
      targetIp: target.ip,
      scriptId: script.id,
      scriptSnapshot: {
        name: script.name,
        body: script.body,
        timeoutSeconds: script.timeoutSeconds,
      },
      requestedBy: `alert-rule:${input.ruleId}`,
      scheduled: true,
    });
    if (!result.ok) {
      console.warn(
        `[alert-rules] remediation skip (${result.reason}) rule ${input.ruleId} asset ${target.assetId}`,
      );
    }
  } catch (err) {
    console.error(
      `[alert-rules] remediation enqueue failed rule ${input.ruleId}:`,
      err,
    );
  }
}
