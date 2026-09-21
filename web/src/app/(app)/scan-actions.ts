"use server";

import { revalidatePath } from "next/cache";

import {
  cancelPendingJob,
  enqueueScan,
  resolveAllTargets,
  resolveAssetTargets,
} from "@/db/scan";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to start scans.",
};

/** Gate every scan mutation on `scan:write`, server-side (AC-9). */
async function requireScanWrite() {
  const user = await getCurrentUser();
  if (!hasPermission(user, "scan:write")) return null;
  return user;
}

/**
 * Enqueue a manual scan (AC-1, AC-2). `scope: "all"` snapshots every known
 * device IP; `scope: "selected"` resolves the chosen asset tags to IPs (the UI's
 * asset "id" is the human tag, not the uuid). Targets are frozen at creation; if
 * nothing resolves, we refuse with a 422-style error.
 */
export async function requestScan(
  scope: unknown,
  assetTags: unknown,
): Promise<ActionResult> {
  const user = await requireScanWrite();
  if (!user) return FORBIDDEN;

  const tags = Array.isArray(assetTags)
    ? assetTags.filter((x): x is string => typeof x === "string")
    : [];

  let targets: string[];
  let jobScope: "all" | "selected";
  if (scope === "all") {
    jobScope = "all";
    targets = await resolveAllTargets();
  } else if (scope === "selected") {
    jobScope = "selected";
    if (tags.length === 0) {
      return { ok: false, error: "Select at least one device to scan." };
    }
    targets = await resolveAssetTargets(tags);
  } else {
    return { ok: false, error: "Unknown scan scope." };
  }

  if (targets.length === 0) {
    return {
      ok: false,
      error:
        "None of the selected devices have a scannable IP address yet, so there is nothing to scan.",
    };
  }

  await enqueueScan({ scope: jobScope, targets, requestedBy: user.email });
  revalidatePath("/scans/jobs");
  const n = targets.length;
  return {
    ok: true,
    message: `Scan queued for ${n} device${n === 1 ? "" : "s"}. The collector will pick it up.`,
  };
}

/** Cancel a still-pending scan job (AC-4 UI). */
export async function cancelScanJob(jobId: unknown): Promise<ActionResult> {
  const user = await requireScanWrite();
  if (!user) return FORBIDDEN;
  if (typeof jobId !== "string" || !jobId) {
    return { ok: false, error: "Missing job id." };
  }

  const canceled = await cancelPendingJob(jobId);
  if (!canceled) {
    return {
      ok: false,
      error: "That job can no longer be canceled (it already started).",
    };
  }
  revalidatePath("/scans/jobs");
  return { ok: true, message: "Scan job canceled." };
}
