import { NextResponse, type NextRequest } from "next/server";

import { apiRefresh } from "@/lib/auth/client";
import {
  ACCESS_COOKIE,
  ACCESS_MAX_AGE,
  COOKIE_OPTIONS,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE,
} from "@/lib/auth/config";

/**
 * Route gate + token refresh. Runs on the nodejs runtime (Next 16 proxy).
 * - Valid access cookie present -> continue (real identity is resolved in the
 *   data layer via getCurrentUser()).
 * - Access expired but refresh present -> refresh against aw-auth and persist
 *   the rotated cookies here (proxy is where Next allows cookie writes on nav).
 * - Otherwise -> redirect to /login (remembering where the user was going).
 */
export async function proxy(request: NextRequest) {
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;

  if (access) return NextResponse.next();

  if (refresh) {
    const refreshed = await apiRefresh(refresh);
    if (refreshed?.access) {
      const res = NextResponse.next();
      res.cookies.set(ACCESS_COOKIE, refreshed.access, {
        ...COOKIE_OPTIONS,
        maxAge: ACCESS_MAX_AGE,
      });
      if (refreshed.refresh) {
        res.cookies.set(REFRESH_COOKIE, refreshed.refresh, {
          ...COOKIE_OPTIONS,
          maxAge: REFRESH_MAX_AGE,
        });
      }
      return res;
    }
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  if (request.nextUrl.pathname !== "/") {
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
  }
  const res = NextResponse.redirect(loginUrl);
  res.cookies.delete(ACCESS_COOKIE);
  res.cookies.delete(REFRESH_COOKIE);
  return res;
}

export const config = {
  // Everything except the login page, auth API, Next internals and static files.
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
