"use client";

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { createUserAction } from "@/app/(app)/users-actions";
import { RolePicker } from "@/components/role-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Role } from "@/lib/auth/types";
import {
  EMPTY_USER_FORM,
  fieldErrors,
  generatePassword,
  userCreateSchema,
  type UserFormValues,
} from "@/lib/user-schema";
import { cn } from "@/lib/utils";

type FieldErrors = Partial<Record<keyof UserFormValues, string>>;

export function UserFormDialog({
  open,
  onOpenChange,
  roles,
  onSuccess,
  defaults,
  lockEmail = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: Role[];
  onSuccess?: () => void;
  /** Prefill email/name, e.g. when creating a login for a directory person. */
  defaults?: { email?: string; full_name?: string };
  /** Make the email read-only (so the login links to the intended person). */
  lockEmail?: boolean;
}) {
  const [values, setValues] = React.useState<UserFormValues>(EMPTY_USER_FORM);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [isPending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setValues({
      ...EMPTY_USER_FORM,
      email: defaults?.email ?? "",
      full_name: defaults?.full_name ?? "",
    });
    // defaults are captured on open; identity changes shouldn't clobber edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set<K extends keyof UserFormValues>(key: K, value: UserFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit() {
    const parsed = userCreateSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors<keyof UserFormValues>(parsed.error));
      return;
    }
    startTransition(async () => {
      const res = await createUserAction(parsed.data);
      if (res.ok) {
        toast.success(res.message, {
          description: "Share the password with the user — it won't be shown again.",
        });
        onOpenChange(false);
        onSuccess?.();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="p-4 pb-3">
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            Create an account with an initial password. The user can change it
            later from their account page.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-3 border-y p-4">
            <Field label="Full name" required error={errors.full_name}>
              <Input
                value={values.full_name}
                onChange={(e) => set("full_name", e.target.value)}
                placeholder="e.g. Sarah Jenkins"
                aria-invalid={!!errors.full_name}
                autoFocus
              />
            </Field>

            <Field label="Email" required error={errors.email}>
              <Input
                type="email"
                value={values.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="name@company.com"
                aria-invalid={!!errors.email}
                readOnly={lockEmail}
                className={lockEmail ? "bg-muted" : undefined}
              />
            </Field>

            <Field label="Initial password" required error={errors.password}>
              <div className="flex gap-2">
                <Input
                  value={values.password}
                  onChange={(e) => set("password", e.target.value)}
                  placeholder="At least 8 characters"
                  aria-invalid={!!errors.password}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => set("password", generatePassword())}
                  title="Generate a random password"
                >
                  <RefreshCw className="size-4" />
                  Generate
                </Button>
              </div>
            </Field>

            <Field label="Roles">
              <RolePicker
                roles={roles}
                selected={values.roles}
                onChange={(next) => set("roles", next)}
              />
            </Field>
          </div>

          <DialogFooter className="rounded-none border-0 bg-transparent p-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  error,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </label>
  );
}
