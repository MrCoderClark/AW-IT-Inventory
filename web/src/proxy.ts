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
  const isApi = request.nextUrl.pathname.startsWith("/api");

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

  // No valid session. /api routes self-authenticate — the cookie ones return 401
  // (the client refreshed its cookie on this same pass if a refresh token was
  // present, so a retry succeeds), and the service/bearer ones (ingest, scan,
  // deploy, remote agent) never had a cookie. Never redirect them to /login; only
  // pages redirect, so a long in-page editing session no longer dead-ends on a
  // 401 the moment the access token lapses.
  if (isApi) return NextResponse.next();

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
  // Runs on pages AND /api (so API requests get the same token refresh as page
  // navigations). Pages redirect to /login when unauthenticated; /api never does
  // (it self-authenticates — cookie routes 401, bearer/service routes verify their
  // own token).
  matcher: [
    "/((?!login|_next/static|_next/image|favicon.ico|h2tecs-favicon.svg|h2tecs-logo.svg|h2tecs-logo-dark.svg).*)",
  ],
};
