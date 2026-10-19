"use server";

import { revalidatePath } from "next/cache";

import {
  buildPatchSelection,
  cancelPatchInstall,
  enqueuePatchInstall,
  getPatchInstallJob,
  resolveDeployTarget,
} from "@/db/patch-install";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";

/**
 * Cookie-side actions for patch install (spec 31 phase 3). Gated on
 * `software:deploy` (AC-15 / AC-20).
 */

type ActionOk = { ok: true; id?: string };
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

export async function requestPatchInstall(input: {
  assetTag: string;
  osKbIds: string[];
  packageIds: string[];
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

  revalidatePath(`/assets/${tag}`);
  return { ok: true, id: enq.id };
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
