import "server-only";

import { redirect } from "next/navigation";

import { apiMe } from "./client";
import { readTokens } from "./cookies";
import type { AuthUser } from "./types";

/**
 * Resolve the current user from the access cookie by introspecting aw-auth
 * (`/me`). Pure read — token *refresh* happens in proxy.ts (the only place Next
 * permits cookie writes during navigation), so this never mutates cookies.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const { access } = await readTokens();
  if (!access) return null;
  return apiMe(access);
}

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export function hasPermission(
  user: AuthUser | null,
  perm: string,
): boolean {
  return !!user && user.permissions.includes(perm);
}
