"use server";

import { revalidatePath } from "next/cache";

import { createRemoteSession, requestEndSession } from "@/db/remote-sessions";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

/**
 * Remote Actions server actions (spec 24). Both gate on `remote:shell` — the most
 * restricted permission in H2Tecs, since a session is arbitrary remote code
 * execution. Ending is additionally owner-checked in the db layer (AC-5). The
 * relay itself (input/output/stream) is the API routes, not actions.
 */

export type StartSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

const NO_PERM = "You don't have permission to open a remote session.";

export async function startRemoteSessionAction(
  assetTag: unknown,
): Promise<StartSessionResult> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "remote:shell")) {
    return { ok: false, error: NO_PERM };
  }
  if (typeof assetTag !== "string" || !assetTag) {
    return { ok: false, error: "Unknown computer." };
  }

  const res = await createRemoteSession({ assetTag, requestedBy: user.email });
  if (!res.ok) {
    const message: Record<typeof res.reason, string> = {
      "not-found": "Unknown computer.",
      "not-computer": "Remote sessions are only available for computers.",
      "no-ip":
        "This computer has no IP on record. Add its IP address first, then try again.",
      "already-open": "A remote session is already open for this computer.",
    };
    return { ok: false, error: message[res.reason] };
  }

  revalidatePath(`/assets/${assetTag}`);
  return { ok: true, sessionId: res.sessionId };
}

export async function endRemoteSessionAction(
  sessionId: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "remote:shell")) {
    return { ok: false, error: NO_PERM };
  }
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, error: "Unknown session." };
  }

  const outcome = await requestEndSession(sessionId, user.email);
  if (outcome === "notfound") {
    return { ok: false, error: "That session no longer exists." };
  }
  if (outcome === "forbidden") {
    return { ok: false, error: "That session belongs to another user." };
  }
  return { ok: true, message: "Session ended." };
}
