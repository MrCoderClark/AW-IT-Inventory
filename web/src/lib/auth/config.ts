/**
 * Portable auth config. Point AUTH_API_URL at any aw-auth instance to reuse
 * this module in another app. All values are plain constants (safe to import
 * from server components, route handlers, and proxy).
 */

export const AUTH_API_URL = (
  process.env.AUTH_API_URL ?? "http://127.0.0.1:8000"
).replace(/\/$/, "");

export const ACCESS_COOKIE = "opus_access";
export const REFRESH_COOKIE = "opus_refresh";

export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

// Cookie lifetimes (seconds). Access cookie expires just *before* the 15-min
// token so the proxy refreshes it rather than ever sending a stale token.
export const ACCESS_MAX_AGE = 60 * 14; // 14 min (token TTL is 15)
export const REFRESH_MAX_AGE = 60 * 60 * 24 * 14; // 14 days
