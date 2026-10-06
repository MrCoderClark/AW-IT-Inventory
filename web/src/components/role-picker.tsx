"use client";

import { Check } from "lucide-react";

import type { Role } from "@/lib/auth/types";
import { cn } from "@/lib/utils";

/**
 * A multi-select of roles rendered as toggle chips. Selection is by role name
 * (what aw-auth stores on the user). Each chip's title lists the role's
 * permission codes so an admin can see what a role grants.
 */
export function RolePicker({
  roles,
  selected,
  onChange,
  disabled,
}: {
  roles: Role[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  function toggle(name: string) {
    onChange(
      selected.includes(name)
        ? selected.filter((r) => r !== name)
        : [...selected, name],
    );
  }

  if (roles.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No roles found. Seed them with{" "}
        <code className="font-mono">manage.py seed_rbac</code>.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {roles.map((role) => {
        const on = selected.includes(role.name);
        return (
          <button
            key={role.name}
            type="button"
            disabled={disabled}
            onClick={() => toggle(role.name)}
            title={
              role.permissions.length
                ? `Grants: ${role.permissions.join(", ")}`
                : "No permissions"
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
              on
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            {on && <Check className="size-3.5" />}
            {role.name}
          </button>
        );
      })}
    </div>
  );
}
