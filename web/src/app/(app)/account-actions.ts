"use server";

import {
  changeMyPassword,
  revokeAllSessions,
  revokeSession,
  updateMyProfile,
} from "@/lib/auth/admin";
import { readTokens } from "@/lib/auth/cookies";
import { getCurrentUser } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";
import {
  firstError,
  passwordChangeSchema,
  profileSchema,
} from "@/lib/user-schema";

const NO_SESSION: ActionResult = {
  ok: false,
  error: "Your session expired. Reload the page and sign in again.",
};

/** Any signed-in user may manage their own account; return their access token. */
async function requireSelfToken(): Promise<
  { access: string } | { error: ActionResult }
> {
  const user = await getCurrentUser();
  if (!user) return { error: NO_SESSION };
  const { access } = await readTokens();
  if (!access) return { error: NO_SESSION };
  return { access };
}

/** The `jti` of the refresh token backing the current browser session. */
function currentRefreshJti(refresh: string | undefined): string | undefined {
  if (!refresh) return undefined;
  try {
    const [, payload] = refresh.split(".");
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.jti === "string" ? json.jti : undefined;
  } catch {
    return undefined;
  }
}

export async function changePasswordAction(raw: unknown): Promise<ActionResult> {
  const auth = await requireSelfToken();
  if ("error" in auth) return auth.error;

  const parsed = passwordChangeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };

  const res = await changeMyPassword(
    auth.access,
    parsed.data.current_password,
    parsed.data.new_password,
  );
  if (!res.ok) return { ok: false, error: res.error };

  return { ok: true, message: "Password changed." };
}

export async function updateProfileAction(raw: unknown): Promise<ActionResult> {
  const auth = await requireSelfToken();
  if ("error" in auth) return auth.error;

  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };

  const res = await updateMyProfile(auth.access, parsed.data.full_name);
  if (!res.ok) return { ok: false, error: res.error };

  return {
    ok: true,
    message: "Profile updated. Sign out and back in to refresh your name everywhere.",
  };
}

export async function revokeSessionAction(jti: unknown): Promise<ActionResult> {
  const auth = await requireSelfToken();
  if ("error" in auth) return auth.error;
  if (typeof jti !== "string" || !jti) {
    return { ok: false, error: "Unknown session." };
  }

  const res = await revokeSession(auth.access, jti);
  if (!res.ok) return { ok: false, error: res.error };

  return { ok: true, message: "Session signed out." };
}

export async function revokeOtherSessionsAction(): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return NO_SESSION;
  const { access, refresh } = await readTokens();
  if (!access) return NO_SESSION;

  const res = await revokeAllSessions(access, currentRefreshJti(refresh));
  if (!res.ok) return { ok: false, error: res.error };

  return {
    ok: true,
    message: `Signed out ${res.data.revoked} other session(s).`,
  };
}
