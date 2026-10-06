"use server";

import { revalidatePath } from "next/cache";

import {
  createUser,
  deleteUser,
  setUserPassword,
  updateUser,
} from "@/lib/auth/admin";
import { readTokens } from "@/lib/auth/cookies";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";
import {
  firstError,
  setPasswordSchema,
  userCreateSchema,
} from "@/lib/user-schema";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to manage users.",
};

const NO_SESSION: ActionResult = {
  ok: false,
  error: "Your session expired. Reload the page and sign in again.",
};

/**
 * Gate on `user:admin` and return the caller's access token. Every mutation
 * here is forwarded to aw-auth with this token, so aw-auth re-enforces RBAC —
 * this check is the fast local gate, not the only one.
 */
async function requireAdminToken(): Promise<
  { access: string } | { error: ActionResult }
> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user, "user:admin")) return { error: FORBIDDEN };
  const { access } = await readTokens();
  if (!access) return { error: NO_SESSION };
  return { access };
}

export async function createUserAction(raw: unknown): Promise<ActionResult> {
  const auth = await requireAdminToken();
  if ("error" in auth) return auth.error;

  const parsed = userCreateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };

  const res = await createUser(auth.access, parsed.data);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/admin/users");
  return { ok: true, message: `Created ${parsed.data.email}.` };
}

export async function updateUserAction(
  id: unknown,
  patch: { full_name?: string; is_active?: boolean; roles?: string[] },
): Promise<ActionResult> {
  const auth = await requireAdminToken();
  if ("error" in auth) return auth.error;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown user." };
  }

  const res = await updateUser(auth.access, id, patch);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${id}`);
  return { ok: true, message: "User updated." };
}

export async function setUserPasswordAction(
  id: unknown,
  raw: unknown,
): Promise<ActionResult> {
  const auth = await requireAdminToken();
  if ("error" in auth) return auth.error;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown user." };
  }

  const parsed = setPasswordSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };

  const res = await setUserPassword(auth.access, id, parsed.data.new_password);
  if (!res.ok) return { ok: false, error: res.error };

  return { ok: true, message: "Password reset." };
}

export async function deleteUserAction(id: unknown): Promise<ActionResult> {
  const auth = await requireAdminToken();
  if ("error" in auth) return auth.error;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown user." };
  }

  const res = await deleteUser(auth.access, id);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/admin/users");
  return { ok: true, message: "User deleted." };
}
