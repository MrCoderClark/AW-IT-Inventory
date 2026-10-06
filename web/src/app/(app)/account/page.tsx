import { AccountView } from "@/components/account-view";
import { listMySessions } from "@/lib/auth/admin";
import { readTokens } from "@/lib/auth/cookies";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** The `jti` of the refresh token backing this browser, to flag "this device". */
function refreshJti(refresh: string | undefined): string | null {
  if (!refresh) return null;
  try {
    const [, payload] = refresh.split(".");
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.jti === "string" ? json.jti : null;
  } catch {
    return null;
  }
}

export default async function Page() {
  const user = await requireUser();
  const { access, refresh } = await readTokens();
  const sessionsRes = await listMySessions(access ?? "");

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6">
      <AccountView
        user={user}
        sessions={sessionsRes.ok ? sessionsRes.data : []}
        sessionsError={sessionsRes.ok ? null : sessionsRes.error}
        currentJti={refreshJti(refresh)}
      />
    </div>
  );
}
