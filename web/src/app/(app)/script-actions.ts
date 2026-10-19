"use server";

import { revalidatePath } from "next/cache";

import {
  cancelScriptRun,
  enqueueScriptRun,
  getScriptRun,
  resolveDeployTarget,
} from "@/db/script-runs";
import {
  archiveScript,
  createScript,
  getScript,
  updateScript,
} from "@/db/scripts";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";

type Ok = { ok: true; id?: string };
type Err = { ok: false; error: string };

const FORBIDDEN: Err = {
  ok: false,
  error: "You don't have permission to manage scripts.",
};

async function requireDeploy() {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "software:deploy")) return null;
  return user;
}

export async function saveScriptAction(input: {
  id?: string;
  name: string;
  description?: string;
  body: string;
  timeoutSeconds?: number;
}): Promise<Ok | Err> {
  const user = await requireDeploy();
  if (!user) return FORBIDDEN;

  const payload = {
    name: input.name,
    description: input.description ?? null,
    body: input.body,
    timeoutSeconds: input.timeoutSeconds,
    actorEmail: user.email,
  };

  const res = input.id
    ? await updateScript(input.id, payload)
    : await createScript(payload);

  if (!res.ok) {
    const msg =
      res.reason === "empty-name"
        ? "Name is required."
        : res.reason === "empty-body"
          ? "Script body is required."
          : res.reason === "body-too-large"
            ? "Script body is too large (max 64 KB)."
            : "Script not found.";
    return { ok: false, error: msg };
  }
  revalidatePath("/scripts");
  return { ok: true, id: res.id };
}

export async function archiveScriptAction(id: string): Promise<Ok | Err> {
  const user = await requireDeploy();
  if (!user) return FORBIDDEN;
  if (!(await archiveScript(id)))
    return { ok: false, error: "Script not found." };
  revalidatePath("/scripts");
  return { ok: true };
}

export async function runScriptAction(
  assetTag: string,
  scriptId: string,
): Promise<Ok | Err> {
  const user = await requireDeploy();
  if (!user) return FORBIDDEN;

  const script = await getScript(scriptId);
  if (!script || script.archivedAt)
    return { ok: false, error: "Script not found." };

  const target = await resolveDeployTarget(assetTag);
  if (!target)
    return {
      ok: false,
      error: "Computer needs an IP address before a script can run.",
    };

  const enq = await enqueueScriptRun({
    assetId: target.assetId,
    targetIp: target.ip,
    scriptId: script.id,
    scriptSnapshot: {
      name: script.name,
      body: script.body,
      timeoutSeconds: script.timeoutSeconds,
    },
    requestedBy: user.email,
  });
  if (!enq.ok)
    return {
      ok: false,
      error: "A script is already running on this computer.",
    };

  revalidatePath(`/assets/${assetTag}`);
  return { ok: true, id: enq.id };
}

export async function cancelScriptRunAction(
  jobId: string,
  assetTag: string,
): Promise<Ok | Err> {
  const user = await requireDeploy();
  if (!user) return FORBIDDEN;
  const job = await getScriptRun(jobId);
  if (!job) return { ok: false, error: "Job not found." };
  if (!(await cancelScriptRun(jobId)))
    return { ok: false, error: "Job is already finished." };
  revalidatePath(`/assets/${assetTag}`);
  return { ok: true };
}
