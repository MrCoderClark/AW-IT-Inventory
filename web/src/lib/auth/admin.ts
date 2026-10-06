/**
 * Calls to aw-auth's admin + self-service endpoints, made on the signed-in
 * user's behalf. Every call forwards the caller's access token as a Bearer
 * header; aw-auth authenticates it (RS256/JWKS) and enforces RBAC (`user:admin`
 * for the admin endpoints). This module never grants privilege of its own — it
 * is the human-caller counterpart of `notify.ts`'s service-account path.
 *
 * Server-only (pure fetch, no next/headers) so it can be called from server
 * actions, which supply the access token from the cookie store.
 */
import "server-only";

import { AUTH_API_URL } from "./config";
import type { AdminUser, AuthApiResult, Role, Session } from "./types";

const base = `${AUTH_API_URL}/v1/auth`;

/** Pull the first human-readable message out of a DRF error body. */
function firstError(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const obj = data as Record<string, unknown>;
  if (typeof obj.detail === "string") return obj.detail;
  for (const value of Object.values(obj)) {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return fallback;
}

async function call<T>(
  access: string,
  path: string,
  init: RequestInit & { fallback: string },
): Promise<AuthApiResult<T>> {
  const { fallback, ...rest } = init;
  try {
    const res = await fetch(`${base}${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access}`,
        ...(rest.headers ?? {}),
      },
      cache: "no-store",
    });
    if (res.ok) {
      // 204 No Content has no body.
      const data = res.status === 204 ? undefined : await res.json();
      return { ok: true, data: data as T };
    }
    const body = await res.json().catch(() => null);
    return { ok: false, status: res.status, error: firstError(body, fallback) };
  } catch {
    return {
      ok: false,
      status: 0,
      error: "Couldn't reach the auth service. Is aw-auth running?",
    };
  }
}

/* ---------------- Admin: users & roles (user:admin) ---------------- */

export function listUsers(access: string) {
  return call<AdminUser[]>(access, "/admin/users", {
    method: "GET",
    fallback: "Couldn't load users.",
  });
}

export function getUser(access: string, id: string) {
  return call<AdminUser>(access, `/admin/users/${id}`, {
    method: "GET",
    fallback: "Couldn't load that user.",
  });
}

/**
 * The login account whose email matches `email` (case-insensitive), or null.
 * aw-auth has no by-email endpoint; the user set is tiny (OPUS operators), so we
 * list and filter. Used to link a People record to its login by email.
 */
export async function getUserByEmail(
  access: string,
  email: string | null | undefined,
): Promise<AdminUser | null> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  const res = await listUsers(access);
  if (!res.ok) return null;
  return res.data.find((u) => u.email.toLowerCase() === normalized) ?? null;
}

export function createUser(
  access: string,
  payload: {
    email: string;
    full_name: string;
    password: string;
    roles: string[];
  },
) {
  return call<AdminUser>(access, "/admin/users", {
    method: "POST",
    body: JSON.stringify(payload),
    fallback: "Couldn't create the user.",
  });
}

export function updateUser(
  access: string,
  id: string,
  patch: { full_name?: string; is_active?: boolean; roles?: string[] },
) {
  return call<AdminUser>(access, `/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    fallback: "Couldn't update the user.",
  });
}

export function setUserPassword(access: string, id: string, newPassword: string) {
  return call<void>(access, `/admin/users/${id}/set-password`, {
    method: "POST",
    body: JSON.stringify({ new_password: newPassword }),
    fallback: "Couldn't set the password.",
  });
}

export function deleteUser(access: string, id: string) {
  return call<void>(access, `/admin/users/${id}`, {
    method: "DELETE",
    fallback: "Couldn't delete the user.",
  });
}

export function listRoles(access: string) {
  return call<Role[]>(access, "/admin/roles", {
    method: "GET",
    fallback: "Couldn't load roles.",
  });
}

/* ---------------- Self-service (any signed-in user) ---------------- */

export function changeMyPassword(
  access: string,
  currentPassword: string,
  newPassword: string,
) {
  return call<void>(access, "/password/change", {
    method: "POST",
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
    fallback: "Couldn't change your password.",
  });
}

export function updateMyProfile(access: string, fullName: string) {
  return call<AdminUser>(access, "/me", {
    method: "PATCH",
    body: JSON.stringify({ full_name: fullName }),
    fallback: "Couldn't update your profile.",
  });
}

export function listMySessions(access: string) {
  return call<Session[]>(access, "/sessions", {
    method: "GET",
    fallback: "Couldn't load your sessions.",
  });
}

export function revokeSession(access: string, jti: string) {
  return call<void>(access, `/sessions/${jti}`, {
    method: "DELETE",
    fallback: "Couldn't revoke that session.",
  });
}

export function revokeAllSessions(access: string, exceptJti?: string) {
  return call<{ revoked: number }>(access, "/sessions/revoke-all", {
    method: "POST",
    body: JSON.stringify(exceptJti ? { except_jti: exceptJti } : {}),
    fallback: "Couldn't revoke your sessions.",
  });
}
