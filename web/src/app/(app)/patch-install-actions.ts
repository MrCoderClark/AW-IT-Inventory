"use server";

import { revalidatePath } from "next/cache";

import {
  enqueueMissingUpdateCheck,
  listMissingUpdateChecksForAssetTag,
  resolveDeployTarget as resolveCheckTarget,
  type MissingCheckListItem,
} from "@/db/missing-update-checks";
import {
  buildPatchSelection,
  cancelPatchInstall,
  enqueueFleetOsPatchInstalls,
  enqueuePatchInstall,
  FLEET_OS_INSTALL_TAG_CAP,
  getPatchInstallJob,
  listPatchInstallsForAssetTag,
  resolveDeployTarget,
  type PatchInstallListItem,
} from "@/db/patch-install";
import { getComputerPatches, type ComputerPatches } from "@/db/patches";
import { enqueueRebootJob } from "@/db/reboot";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";

/**
 * Cookie-side actions for patch install (spec 31 phase 3). Gated on
 * `software:deploy` (AC-15 / AC-20).
 */

type ActionOk = { ok: true; id?: string; rebootWarning?: string };
type ActionErr = {
  ok: false;
  error: string;
  code?: "forbidden" | "notfound" | "conflict" | "badrequest";
};

const FORBIDDEN: ActionErr = {
  ok: false,
  error: "You don't have permission to install patches.",
  code: "forbidden",
};

function rebootSkipMessage(reason: "already-inflight" | "past-schedule"): string {
  if (reason === "past-schedule") {
    return "Reboot time was in the past — install queued without a linked reboot.";
  }
  return "A reboot is already scheduled or in progress — install queued without a linked reboot.";
}

async function enqueueLinkedRebootAfterInstall(input: {
  installJobId: string;
  assetId: string;
  targetIp: string;
  rebootAtIso: string;
  requestedBy: string;
}): Promise<string | undefined> {
  const iso = input.rebootAtIso.trim();
  if (!iso) return undefined;
  const scheduledAt = new Date(iso);
  if (Number.isNaN(scheduledAt.getTime())) {
    return "Invalid reboot time — install queued without a linked reboot.";
  }
  const enq = await enqueueRebootJob({
    assetId: input.assetId,
    targetIp: input.targetIp,
    scheduledAt,
    requestedBy: input.requestedBy,
    sourcePatchInstallJobId: input.installJobId,
  });
  if (!enq.ok) return rebootSkipMessage(enq.reason);
  return undefined;
}

export async function requestPatchInstall(input: {
  assetTag: string;
  osKbIds: string[];
  packageIds: string[];
  rebootAtIso?: string;
}): Promise<ActionOk | ActionErr> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const tag = (input.assetTag ?? "").trim();
  if (!tag) return { ok: false, error: "Missing asset.", code: "badrequest" };

  const target = await resolveDeployTarget(tag);
  if (!target) {
    return {
      ok: false,
      error: "Computer needs an IP address before patches can be installed.",
      code: "badrequest",
    };
  }

  const built = await buildPatchSelection(
    target.assetId,
    input.osKbIds ?? [],
    input.packageIds ?? [],
  );
  if (!built.ok) {
    return {
      ok: false,
      error:
        built.reason === "empty"
          ? "Select at least one OS update or app upgrade."
          : "Selection is stale — refresh and pick again.",
      code: "badrequest",
    };
  }

  const enq = await enqueuePatchInstall({
    assetId: target.assetId,
    targetIp: target.ip,
    selection: built.selection,
    requestedBy: user.email,
  });
  if (!enq.ok) {
    return {
      ok: false,
      error: "A patch install is already in progress on this computer.",
      code: "conflict",
    };
  }

  const rebootWarning =
    input.rebootAtIso?.trim()
      ? await enqueueLinkedRebootAfterInstall({
          installJobId: enq.id,
          assetId: target.assetId,
          targetIp: target.ip,
          rebootAtIso: input.rebootAtIso,
          requestedBy: user.email,
        })
      : undefined;

  revalidatePath(`/assets/${tag}`);
  return rebootWarning
    ? { ok: true, id: enq.id, rebootWarning }
    : { ok: true, id: enq.id };
}

export async function requestFleetOsPatchInstall(input: {
  assetTags: string[];
  rebootAtIso?: string;
}): Promise<
  | {
      ok: true;
      enqueued: string[];
      skipped: { tag: string; reason: string }[];
      rebootWarnings?: { installId: string; message: string }[];
    }
  | ActionErr
> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const tags = (input.assetTags ?? []).map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) {
    return {
      ok: false,
      error: "Select at least one computer.",
      code: "badrequest",
    };
  }
  if (tags.length > FLEET_OS_INSTALL_TAG_CAP) {
    return {
      ok: false,
      error: `Select at most ${FLEET_OS_INSTALL_TAG_CAP} computers.`,
      code: "badrequest",
    };
  }

  const result = await enqueueFleetOsPatchInstalls({
    tags,
    requestedBy: user.email,
  });

  let rebootWarnings: { installId: string; message: string }[] | undefined;
  if (input.rebootAtIso?.trim() && result.enqueued.length) {
    rebootWarnings = [];
    for (const installId of result.enqueued) {
      const job = await getPatchInstallJob(installId);
      if (!job) continue;
      const message = await enqueueLinkedRebootAfterInstall({
        installJobId: installId,
        assetId: job.assetId,
        targetIp: job.targetIp,
        rebootAtIso: input.rebootAtIso,
        requestedBy: user.email,
      });
      if (message) rebootWarnings.push({ installId, message });
    }
    if (rebootWarnings.length === 0) rebootWarnings = undefined;
  }

  revalidatePath("/patches");
  return rebootWarnings
    ? { ok: true, ...result, rebootWarnings }
    : { ok: true, ...result };
}

export async function requestCancelPatchInstall(input: {
  jobId: string;
  assetTag: string;
}): Promise<ActionOk | ActionErr> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const job = await getPatchInstallJob(input.jobId);
  if (!job) return { ok: false, error: "Job not found.", code: "notfound" };

  const canceled = await cancelPatchInstall(input.jobId);
  if (!canceled) {
    return {
      ok: false,
      error: "Job is already finished.",
      code: "conflict",
    };
  }

  revalidatePath(`/assets/${input.assetTag}`);
  return { ok: true };
}

/** One-host missing Search (spec 31 AC-21). */
export async function requestMissingUpdateCheck(input: {
  assetTag: string;
}): Promise<ActionOk | ActionErr> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;

  const tag = (input.assetTag ?? "").trim();
  if (!tag) return { ok: false, error: "Missing asset.", code: "badrequest" };

  const target = await resolveCheckTarget(tag);
  if (!target) {
    return {
      ok: false,
      error: "Computer needs an IP address before updates can be checked.",
      code: "badrequest",
    };
  }

  const enq = await enqueueMissingUpdateCheck({
    assetId: target.assetId,
    targetIp: target.ip,
    requestedBy: user.email,
  });
  if (!enq.ok) {
    return {
      ok: false,
      error: "A Check for updates is already in progress on this computer.",
      code: "conflict",
    };
  }

  revalidatePath(`/assets/${tag}`);
  return { ok: true, id: enq.id };
}

/** Live Updates-tab snapshot (no full page reload). Any signed-in user. */
export async function pollUpdatesSnapshot(assetTag: string): Promise<
  | {
      ok: true;
      patches: ComputerPatches | null;
      patchJobs: PatchInstallListItem[];
      checkJobs: MissingCheckListItem[];
    }
  | ActionErr
> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, error: "Not signed in.", code: "forbidden" };
  }
  const tag = (assetTag ?? "").trim();
  if (!tag) return { ok: false, error: "Missing asset.", code: "badrequest" };

  const [patches, patchJobs, checkJobs] = await Promise.all([
    getComputerPatches(tag),
    listPatchInstallsForAssetTag(tag, 20),
    listMissingUpdateChecksForAssetTag(tag, 10),
  ]);
  return { ok: true, patches, patchJobs, checkJobs };
}
