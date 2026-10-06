"use client";

import * as React from "react";
import { Loader2, LogOut, Monitor } from "lucide-react";
import { toast } from "sonner";

import {
  changePasswordAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  updateProfileAction,
} from "@/app/(app)/account-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AuthUser, Session } from "@/lib/auth/types";

function fmt(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

export function AccountView({
  user,
  sessions,
  sessionsError,
  currentJti,
}: {
  user: AuthUser;
  sessions: Session[];
  sessionsError: string | null;
  currentJti: string | null;
}) {
  return (
    <>
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">My account</h1>
        <p className="text-sm text-muted-foreground">
          {user.email}
          {user.roles.length > 0 && (
            <>
              {" · "}
              {user.roles.join(", ")}
            </>
          )}
        </p>
      </div>

      <ProfileCard initialName={user.full_name} />
      <PasswordCard />
      <SessionsCard
        sessions={sessions}
        error={sessionsError}
        currentJti={currentJti}
      />
    </>
  );
}

function ProfileCard({ initialName }: { initialName: string }) {
  const [name, setName] = React.useState(initialName);
  const [pending, start] = React.useTransition();

  function save() {
    start(async () => {
      const res = await updateProfileAction({ full_name: name });
      res.ok ? toast.success(res.message) : toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Your display name across OPUS.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Full name
          </span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <Button onClick={save} disabled={pending || name === initialName}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [pending, start] = React.useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await changePasswordAction({
        current_password: current,
        new_password: next,
        confirm_password: confirm,
      });
      if (res.ok) {
        toast.success(res.message);
        setCurrent("");
        setNext("");
        setConfirm("");
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          You&apos;ll need your current password to set a new one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <div>
            <Button type="submit" disabled={pending || !current || !next}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionsCard({
  sessions,
  error,
  currentJti,
}: {
  sessions: Session[];
  error: string | null;
  currentJti: string | null;
}) {
  const [pending, start] = React.useTransition();
  const [revoking, setRevoking] = React.useState<string | null>(null);

  function revokeOne(jti: string) {
    setRevoking(jti);
    start(async () => {
      const res = await revokeSessionAction(jti);
      res.ok ? toast.success(res.message) : toast.error(res.error);
      setRevoking(null);
    });
  }

  function revokeOthers() {
    start(async () => {
      const res = await revokeOtherSessionsAction();
      res.ok ? toast.success(res.message) : toast.error(res.error);
    });
  }

  const others = sessions.filter((s) => s.jti !== currentJti);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>
          Each sign-in that can still refresh. Revoking stops future refreshes;
          an already-issued session ends within ~15 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sessions.map((s) => {
              const isCurrent = s.jti === currentJti;
              return (
                <li
                  key={s.jti}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <Monitor className="size-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">
                        Session started {fmt(s.created_at)}
                        {isCurrent && (
                          <Badge variant="outline" className="ml-2">
                            This device
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Expires {fmt(s.expires_at)}
                      </p>
                    </div>
                  </div>
                  {!isCurrent && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => revokeOne(s.jti)}
                      disabled={pending}
                    >
                      {revoking === s.jti && (
                        <Loader2 className="size-3.5 animate-spin" />
                      )}
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {others.length > 0 && (
          <div>
            <Button
              variant="outline"
              onClick={revokeOthers}
              disabled={pending}
            >
              <LogOut className="size-4" />
              Sign out everywhere else
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
