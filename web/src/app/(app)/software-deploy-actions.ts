"use server";

import { revalidatePath } from "next/cache";

import {
  cancelDeployment,
  enqueueDeployment,
  resolveDeployTarget,
} from "@/db/software-deploy";
import {
  getSoftwarePackage,
  removeSoftwarePackage,
} from "@/db/software-packages";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { removeObject } from "@/lib/storage";
import type { ActionResult } from "@/lib/data";

/**
 * Server actions for Software Deployment (spec 23). Package management (delete) and
 * the deploy / cancel triggers. Everything is gated on `software:deploy`, rechecked
 * server-side.
 */

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to manage software deployment.",
};

/**
 * Deploy a library package to a computer (AC-2). Validates the target is a Computer
 * with an IP, freezes a snapshot of the package's steps onto the job, and enqueues
 * it (refused if a deployment is already in flight on that computer, AC-10).
 */
export async function deploySoftwareAction(
  assetTag: unknown,
  packageId: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;
  if (typeof assetTag !== "string" || !assetTag)
    return { ok: false, error: "Unknown computer." };
  if (typeof packageId !== "string" || !packageId)
    return { ok: false, error: "Choose a package to deploy." };

  const target = await resolveDeployTarget(assetTag);
  if (!target)
    return {
      ok: false,
      error: "This must be a Computer with a known IP address.",
    };

  const pkg = await getSoftwarePackage(packageId);
  if (!pkg || pkg.archivedAt)
    return { ok: false, error: "That package is no longer available." };
  if (pkg.steps.length === 0)
    return { ok: false, error: "That package has no steps to run." };

  const res = await enqueueDeployment({
    assetId: target.assetId,
    targetIp: target.ip,
    packageId: pkg.id,
    packageSnapshot: { name: pkg.name, version: pkg.version, steps: pkg.steps },
    requestedBy: user.email,
  });
  if (!res.ok)
    return {
      ok: false,
      error: "A deployment is already in progress on this computer.",
    };

  revalidatePath(`/assets/${assetTag}`);
  return { ok: true, message: `Deploying "${pkg.name}" ${pkg.version}.` };
}

/** Cancel an in-flight deployment (AC-10). Fenced, so a late worker result no-ops. */
export async function cancelDeploymentAction(
  deploymentId: unknown,
  assetTag?: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return FORBIDDEN;
  if (typeof deploymentId !== "string" || !deploymentId)
    return { ok: false, error: "Unknown deployment." };

  const ok = await cancelDeployment(deploymentId);
  if (!ok)
    return { ok: false, error: "That deployment can no longer be canceled." };

  if (typeof assetTag === "string" && assetTag)
    revalidatePath(`/assets/${assetTag}`);
  return { ok: true, message: "Deployment canceled." };
}

/**
 * Remove a package from the library. The frozen snapshot on each deployment keeps
 * history readable, so a referenced package is soft-archived (hidden, history
 * intact) and an unreferenced one is hard-deleted; either way the stored bytes are
 * removed to reclaim space (AC-10).
 */
export async function deleteSoftwarePackageAction(
  packageId: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "software:deploy")) return FORBIDDEN;
  if (typeof packageId !== "string" || !packageId)
    return { ok: false, error: "Unknown package." };

  const res = await removeSoftwarePackage(packageId);
  if (res.outcome === "notfound")
    return { ok: false, error: "That package is no longer in the library." };

  // Reclaim every install step's bytes in both the deleted and archived cases.
  await Promise.all(res.storageKeys.map((k) => removeObject(k)));

  revalidatePath("/software/library");
  return {
    ok: true,
    message:
      res.outcome === "archived"
        ? "Package archived (kept for deployment history)."
        : "Package deleted.",
  };
}
