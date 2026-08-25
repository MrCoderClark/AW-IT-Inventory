/**
 * Local access-token verification against aw-auth's JWKS (RS256).
 *
 * Verifies signature, expiry and issuer without any network round-trip per
 * request (jose caches the JWKS and refetches on key rotation). The user is
 * built straight from the verified claims, so no `/me` call is needed on the
 * happy path. Portable: point JWKS_URI/AUTH_ISSUER at any aw-auth instance.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { AUTH_ISSUER, JWKS_URI } from "./config";
import type { AuthUser } from "./types";

// Module-level singleton: caches keys across requests.
const jwks = createRemoteJWKSet(new URL(JWKS_URI));

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function userFromClaims(payload: JWTPayload): AuthUser {
  return {
    id: String(payload.user_id ?? payload.sub ?? ""),
    email: typeof payload.email === "string" ? payload.email : "",
    full_name: typeof payload.name === "string" ? payload.name : "",
    is_active: true,
    is_staff: Boolean(payload.is_staff ?? false),
    mfa_enabled: Boolean(payload.mfa_enabled ?? false),
    date_joined: "",
    roles: asStringArray(payload.roles),
    permissions: asStringArray(payload.perms),
  };
}

/**
 * Verify an access token locally. Returns the user on success, or null if the
 * token is invalid/expired or the keys can't be fetched (caller may fall back
 * to introspection).
 */
export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: AUTH_ISSUER,
    });
    if (payload.token_type && payload.token_type !== "access") return null;
    return userFromClaims(payload);
  } catch {
    return null;
  }
}
