import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { PersonDetail } from "@/components/person-detail";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getPersonAssignments } from "@/db/assignments";
import { getPersonById } from "@/db/people";
import { getAssignableAssets, getLocationOptions } from "@/db/queries";
import { getUserByEmail, listRoles } from "@/lib/auth/admin";
import { readTokens } from "@/lib/auth/cookies";
import { hasPermission, requireUser } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/types";
import type { LinkedAccount } from "@/components/person-detail";

// Devices and history change on each assignment; read fresh.
export const dynamic = "force-dynamic";

export default async function Page({ params }: PageProps<"/people/[id]">) {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Person"
        description="You don't have permission to view the directory. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const { id } = await params;
  const canWrite = hasPermission(user, "asset:write");

  const person = await getPersonById(id);
  if (!person) notFound();

  const [{ currentDevices, history }, assignableAssets, locations] =
    await Promise.all([
      getPersonAssignments(id),
      canWrite ? getAssignableAssets() : Promise.resolve([]),
      canWrite ? getLocationOptions() : Promise.resolve([]),
    ]);

  // Admins see whether this person has an OPUS login (linked by email) and can
  // create one. Resolved from aw-auth with the admin's own token.
  const canManageUsers = hasPermission(user, "user:admin");
  let account: LinkedAccount | null = null;
  let roles: Role[] = [];
  if (canManageUsers) {
    const { access } = await readTokens();
    const token = access ?? "";
    const [matched, rolesRes] = await Promise.all([
      getUserByEmail(token, person.email),
      listRoles(token),
    ]);
    account = matched
      ? { id: matched.id, roles: matched.roles, is_active: matched.is_active }
      : null;
    if (rolesRes.ok) roles = rolesRes.data;
  }

  return (
    <PersonDetail
      person={person}
      currentDevices={currentDevices}
      history={history}
      assignableAssets={assignableAssets}
      canWrite={canWrite}
      locations={locations}
      account={account}
      canManageUsers={canManageUsers}
      roles={roles}
    />
  );
}
