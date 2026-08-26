/**
 * Service-token verification for machine-to-machine calls (e.g. the collector
 * hitting the ingest API). Verifies the RS256 token via JWKS, confirms it's a
 * service token (`typ=service`), and checks it carries the required scope.
 */

import { jwtVerify } from "jose";

import { AUTH_ISSUER } from "./config";
import { jwks } from "./verify";

export interface ServiceIdentity {
  clientId: string;
  scopes: string[];
}

export async function verifyServiceToken(
  token: string,
  requiredScope?: string,
): Promise<ServiceIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: AUTH_ISSUER });
    if (payload.typ !== "service") return null;
    const scopes = Array.isArray(payload.scopes)
      ? (payload.scopes.filter((s) => typeof s === "string") as string[])
      : [];
    if (requiredScope && !scopes.includes(requiredScope)) return null;
    return { clientId: String(payload.client_id ?? ""), scopes };
  } catch {
    return null;
  }
}

/** Extract a bearer token from an Authorization header. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}
