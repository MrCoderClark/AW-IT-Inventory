import "server-only";

import { cookies } from "next/headers";

import {
  ACCESS_COOKIE,
  ACCESS_MAX_AGE,
  COOKIE_OPTIONS,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE,
} from "./config";

/** Set both auth cookies. Call only from a Route Handler or Server Action. */
export async function setAuthCookies(access: string, refresh: string) {
  const store = await cookies();
  store.set(ACCESS_COOKIE, access, { ...COOKIE_OPTIONS, maxAge: ACCESS_MAX_AGE });
  store.set(REFRESH_COOKIE, refresh, {
    ...COOKIE_OPTIONS,
    maxAge: REFRESH_MAX_AGE,
  });
}

export async function clearAuthCookies() {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}

export async function readTokens() {
  const store = await cookies();
  return {
    access: store.get(ACCESS_COOKIE)?.value,
    refresh: store.get(REFRESH_COOKIE)?.value,
  };
}
