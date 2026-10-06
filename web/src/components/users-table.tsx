"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserPlus, Users } from "lucide-react";

import { UserFormDialog } from "@/components/user-form-dialog";
import { HeroHeader } from "@/components/hero-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminUser, Role } from "@/lib/auth/types";

function fmtDate(value: string | null): string {
  if (!value) return "Never";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function UsersTable({
  users,
  roles,
  currentUserId,
  peopleByEmail = {},
}: {
  users: AdminUser[];
  roles: Role[];
  currentUserId: string;
  /** email (lowercased) → the staff record linked by email, for the Directory column. */
  peopleByEmail?: Record<string, { id: string; name: string }>;
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <>
      <HeroHeader
        title="Users"
        subtitle="Create accounts, assign roles and manage access to OPUS."
        icon={<Users className="size-6" />}
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <UserPlus className="size-4" />
            New user
          </Button>
        }
      />

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Directory</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last sign-in</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const person = peopleByEmail[u.email.toLowerCase()];
              return (
              <TableRow
                key={u.id}
                className="cursor-pointer"
                onClick={() => router.push(`/admin/users/${u.id}`)}
              >
                <TableCell className="font-medium">
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {u.full_name || "—"}
                  </Link>
                  {u.id === currentUserId && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (you)
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {u.email}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {u.roles.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        No roles
                      </span>
                    ) : (
                      u.roles.map((r) => (
                        <Badge key={r} variant="secondary">
                          {r}
                        </Badge>
                      ))
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {person ? (
                    <Link
                      href={`/people/${person.id}`}
                      className="text-sm hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {person.name}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {u.is_active ? (
                    <Badge variant="outline">Active</Badge>
                  ) : (
                    <Badge variant="destructive">Disabled</Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {fmtDate(u.last_login)}
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <UserFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        roles={roles}
        onSuccess={() => router.refresh()}
      />
    </>
  );
}
