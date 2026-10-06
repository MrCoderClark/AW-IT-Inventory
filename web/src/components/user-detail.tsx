"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  deleteUserAction,
  setUserPasswordAction,
  updateUserAction,
} from "@/app/(app)/users-actions";
import { RolePicker } from "@/components/role-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AdminUser, Role } from "@/lib/auth/types";
import type { DirectoryPerson } from "@/lib/data";
import { generatePassword, setPasswordSchema } from "@/lib/user-schema";

export function UserDetail({
  target,
  roles,
  isSelf,
  linkedPerson,
}: {
  target: AdminUser;
  roles: Role[];
  isSelf: boolean;
  /** The directory person with the same email, if any (linked by email). */
  linkedPerson?: DirectoryPerson | null;
}) {
  const router = useRouter();

  const [fullName, setFullName] = React.useState(target.full_name);
  const [selectedRoles, setSelectedRoles] = React.useState<string[]>(
    target.roles,
  );
  const [isActive, setIsActive] = React.useState(target.is_active);
  const [savingProfile, startSaveProfile] = React.useTransition();
  const [savingAccess, startSaveAccess] = React.useTransition();

  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [resetting, startReset] = React.useTransition();

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, startDelete] = React.useTransition();

  function saveProfile() {
    startSaveProfile(async () => {
      const res = await updateUserAction(target.id, { full_name: fullName });
      res.ok ? toast.success(res.message) : toast.error(res.error);
      if (res.ok) router.refresh();
    });
  }

  function saveAccess() {
    startSaveAccess(async () => {
      const res = await updateUserAction(target.id, {
        roles: selectedRoles,
        is_active: isActive,
      });
      res.ok ? toast.success(res.message) : toast.error(res.error);
      if (res.ok) router.refresh();
    });
  }

  function resetPassword() {
    const parsed = setPasswordSchema.safeParse({
      new_password: newPassword,
      confirm_password: confirmPassword,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid password.");
      return;
    }
    startReset(async () => {
      const res = await setUserPasswordAction(target.id, parsed.data);
      if (res.ok) {
        toast.success(res.message, {
          description: "Share the new password with the user.",
        });
        setNewPassword("");
        setConfirmPassword("");
      } else {
        toast.error(res.error);
      }
    });
  }

  function confirmDelete() {
    startDelete(async () => {
      const res = await deleteUserAction(target.id);
      if (res.ok) {
        toast.success(res.message);
        router.push("/admin/users");
      } else {
        toast.error(res.error);
        setDeleteOpen(false);
      }
    });
  }

  return (
    <>
      <div>
        <Link
          href="/admin/users"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> All users
        </Link>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight">
          {target.full_name || target.email}
        </h1>
        <p className="text-sm text-muted-foreground">{target.email}</p>
      </div>

      {/* Directory link (by email). Shows this login's staff record + devices,
          so you don't maintain the person twice. */}
      <Card>
        <CardHeader>
          <CardTitle>Directory entry</CardTitle>
          <CardDescription>
            The staff record matched to this login by email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {linkedPerson ? (
            <Link
              href={`/people/${linkedPerson.id}`}
              className="flex items-center justify-between gap-3 rounded-lg border p-3 hover:bg-muted"
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="grid size-10 place-items-center rounded-full bg-accent text-sm font-semibold text-primary"
                >
                  {linkedPerson.initials}
                </span>
                <div>
                  <p className="text-sm font-medium">{linkedPerson.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[linkedPerson.jobTitle, linkedPerson.department]
                      .filter(Boolean)
                      .join(" · ") || "No role on file"}
                  </p>
                </div>
              </div>
              <Badge variant="secondary">
                {linkedPerson.deviceCount} device
                {linkedPerson.deviceCount === 1 ? "" : "s"}
              </Badge>
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">
              No directory entry has this email. The staff directory and logins
              link up automatically when their emails match.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>The user&apos;s display name.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Full name
            </span>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </label>
          <div>
            <Button
              onClick={saveProfile}
              disabled={savingProfile || fullName === target.full_name}
            >
              {savingProfile && <Loader2 className="size-4 animate-spin" />}
              Save profile
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Access: roles + active */}
      <Card>
        <CardHeader>
          <CardTitle>Access</CardTitle>
          <CardDescription>
            Roles decide what this user can do. A change takes effect the next
            time they sign in.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <RolePicker
            roles={roles}
            selected={selectedRoles}
            onChange={setSelectedRoles}
          />

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Account active</p>
              <p className="text-xs text-muted-foreground">
                {isSelf
                  ? "You can't deactivate your own account."
                  : "Turn off to block sign-in without deleting the account."}
              </p>
            </div>
            <Switch
              checked={isActive}
              onCheckedChange={setIsActive}
              disabled={isSelf}
            />
          </div>

          <div>
            <Button
              onClick={saveAccess}
              disabled={
                savingAccess ||
                (isActive === target.is_active &&
                  sameSet(selectedRoles, target.roles))
              }
            >
              {savingAccess && <Loader2 className="size-4 animate-spin" />}
              Save access
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Reset password */}
      <Card>
        <CardHeader>
          <CardTitle>Reset password</CardTitle>
          <CardDescription>
            Set a new password for this user. It&apos;s shown only here — share
            it with them, and they can change it on their account page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              className="font-mono"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const pw = generatePassword();
                setNewPassword(pw);
                setConfirmPassword(pw);
              }}
            >
              <RefreshCw className="size-4" />
              Generate
            </Button>
          </div>
          <Input
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            className="font-mono"
          />
          <div>
            <Button
              onClick={resetPassword}
              disabled={resetting || !newPassword}
            >
              {resetting && <Loader2 className="size-4 animate-spin" />}
              Reset password
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Danger zone */}
      {!isSelf && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Delete user</CardTitle>
            <CardDescription>
              Permanently remove this account. This can&apos;t be undone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" /> Delete user
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete {target.email}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the account. Consider deactivating it
              instead if you might need it again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}
