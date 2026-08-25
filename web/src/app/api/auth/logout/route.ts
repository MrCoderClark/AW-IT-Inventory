import { NextResponse } from "next/server";

import { apiLogout } from "@/lib/auth/client";
import { clearAuthCookies, readTokens } from "@/lib/auth/cookies";

export async function POST() {
  const { refresh } = await readTokens();
  if (refresh) await apiLogout(refresh);
  await clearAuthCookies();
  return NextResponse.json({ ok: true });
}
