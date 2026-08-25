/**
 * Low-level calls to the aw-auth service. Server/proxy only (never expose to
 * the browser). Pure fetch — no next/headers — so it is safe to use in proxy.
 */

import { AUTH_API_URL } from "./config";
import type { AuthUser, RefreshResult, TokenPair } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function apiLogin(
  email: string,
  password: string,
): Promise<TokenPair | null> {
  try {
    const res = await fetch(`${AUTH_API_URL}/v1/auth/login`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiRefresh(
  refresh: string,
): Promise<RefreshResult | null> {
  try {
    const res = await fetch(`${AUTH_API_URL}/v1/auth/token/refresh`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ refresh }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiMe(access: string): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${AUTH_API_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${access}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiLogout(refresh: string): Promise<void> {
  await fetch(`${AUTH_API_URL}/v1/auth/logout`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ refresh }),
    cache: "no-store",
  }).catch(() => {
    /* best-effort: cookies are cleared regardless */
  });
}
