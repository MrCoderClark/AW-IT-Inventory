"use server";

import { revalidatePath } from "next/cache";

import {
  archivePerson,
  createPerson,
  deletePerson,
  restorePerson,
  updatePerson,
  type PersonWriteError,
} from "@/db/people";
import {
  assignAsset,
  resolveAssetId,
  returnAsset,
  type AssignError,
} from "@/db/assignments";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { AuthUser } from "@/lib/auth/types";
import { personInputSchema, personFirstError } from "@/lib/person-schema";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to manage people.",
};

/** Resolve the current user only if they may write; null otherwise. Every
   mutation here is `asset:write`, rechecked server-side (AC-10). */
async function requireWriter(): Promise<AuthUser | null> {
  const user = await getCurrentUser();
  return user && hasPermission(user, "asset:write") ? user : null;
}

/** Map a people-write error to a user-facing message. */
function personErrorMessage(error: PersonWriteError): string {
  switch (error) {
    case "empty-name":
      return "A name is required.";
    case "duplicate-email":
      return "That email is already used by someone else.";
    case "duplicate-employee":
      return "That employee id is already used by someone else.";
    case "not-found":
      return "That person no longer exists.";
  }
}

/** Map an assignment-engine error to a user-facing message. */
function assignErrorMessage(error: AssignError): string {
  switch (error) {
    case "asset-not-found":
      return "That device no longer exists. Refresh and try again.";
    case "person-not-found":
      return "That person no longer exists. Refresh and try again.";
    case "person-archived":
      return "That person is archived. Restore them first, or pick someone else.";
    case "already-assigned":
      return "That device was just assigned to someone else. Refresh and try again.";
  }
}

/** Refresh every surface a person or assignment change can touch. */
function revalidatePeople(personId?: string) {
  revalidatePath("/people");
  if (personId) revalidatePath(`/people/${personId}`);
}

/* ---------------- Person lifecycle (AC-1, AC-8, AC-9, AC-10) ---------------- */

export async function createPersonAction(raw: unknown): Promise<ActionResult> {
  if (!(await requireWriter())) return FORBIDDEN;

  const parsed = personInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: personFirstError(parsed.error) };
  }

  const result = await createPerson(parsed.data);
  if (!result.ok) return { ok: false, error: personErrorMessage(result.error) };

  revalidatePeople();
  return { ok: true, message: `Added ${parsed.data.name}.` };
}

export async function updatePersonAction(
  id: unknown,
  raw: unknown,
): Promise<ActionResult> {
  if (!(await requireWriter())) return FORBIDDEN;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown person." };
  }

  const parsed = personInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: personFirstError(parsed.error) };
  }

  const result = await updatePerson(id, parsed.data);
  if (!result.ok) return { ok: false, error: personErrorMessage(result.error) };

  revalidatePeople(id);
  return { ok: true, message: "Person updated." };
}

export async function archivePersonAction(id: unknown): Promise<ActionResult> {
  const user = await requireWriter();
  if (!user) return FORBIDDEN;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown person." };
  }

  const ok = await archivePerson(id, user.email);
  if (!ok) return { ok: false, error: "That person no longer exists." };

  revalidatePeople(id);
  // Devices returned to the pool: refresh the asset surfaces too.
  revalidatePath("/dashboard");
  return {
    ok: true,
    message: "Person archived. Their devices returned to the pool.",
  };
}

export async function restorePersonAction(id: unknown): Promise<ActionResult> {
  if (!(await requireWriter())) return FORBIDDEN;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown person." };
  }

  const ok = await restorePerson(id);
  if (!ok) return { ok: false, error: "That person no longer exists." };

  revalidatePeople(id);
  return { ok: true, message: "Person restored to active." };
}

export async function deletePersonAction(id: unknown): Promise<ActionResult> {
  if (!(await requireWriter())) return FORBIDDEN;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown person." };
  }

  const result = await deletePerson(id);
  if (result === "not-found") {
    return { ok: false, error: "That person no longer exists." };
  }
  if (result === "has-history") {
    return {
      ok: false,
      error:
        "This person has assignment history and can't be deleted. Archive them instead.",
    };
  }

  revalidatePeople();
  return { ok: true, message: "Person deleted." };
}

/* ---------------- Assignment (AC-5, AC-6, AC-10) ----------------
   Reachable from the person page and the asset page. Both pass the asset's human
   tag; the asset FORM calls the engine directly with the id it already holds. */

export async function assignAssetAction(
  assetTag: unknown,
  personId: unknown,
): Promise<ActionResult> {
  const user = await requireWriter();
  if (!user) return FORBIDDEN;
  if (typeof assetTag !== "string" || !assetTag) {
    return { ok: false, error: "Unknown device." };
  }
  if (typeof personId !== "string" || !personId) {
    return { ok: false, error: "Choose a person to assign to." };
  }

  const assetId = await resolveAssetId(assetTag);
  if (!assetId) {
    return { ok: false, error: "That device no longer exists." };
  }

  const result = await assignAsset(assetId, personId, user.email);
  if (!result.ok) return { ok: false, error: assignErrorMessage(result.error) };

  revalidatePeople(personId);
  revalidatePath(`/assets/${assetTag}`);
  revalidatePath("/dashboard");
  return { ok: true, message: "Device assigned." };
}

export async function returnAssetAction(
  assetTag: unknown,
): Promise<ActionResult> {
  const user = await requireWriter();
  if (!user) return FORBIDDEN;
  if (typeof assetTag !== "string" || !assetTag) {
    return { ok: false, error: "Unknown device." };
  }

  const assetId = await resolveAssetId(assetTag);
  if (!assetId) {
    return { ok: false, error: "That device no longer exists." };
  }

  const result = await returnAsset(assetId, user.email);
  if (!result.changed) {
    return { ok: false, error: "That device isn't currently assigned." };
  }

  revalidatePeople();
  revalidatePath(`/assets/${assetTag}`);
  revalidatePath("/dashboard");
  return { ok: true, message: "Device returned to the pool." };
}
