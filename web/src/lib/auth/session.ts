import "server-only";

import { redirect } from "next/navigation";

import { apiMe } from "./client";
import { readTokens } from "./cookies";
import { verifyAccessToken } from "./verify";
import type { AuthUser } from "./types";

/**
 * Resolve the current user from the access cookie.
 *
 * Fast path: verify the token locally against aw-auth's JWKS (no network per
 * request) and build the user from its claims. Fallback: introspect `/me` when
 * local verification isn't possible (e.g. aw-auth on HS256, or a transient
 * JWKS fetch failure). Pure read — token *refresh* happens in proxy.ts.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const { access } = await readTokens();
  if (!access) return null;

  const local = await verifyAccessToken(access);
  if (local) return local;

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
