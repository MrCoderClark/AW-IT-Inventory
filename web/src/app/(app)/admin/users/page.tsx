import { Lock, Users } from "lucide-react";

import { UsersTable } from "@/components/users-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getDirectoryPeople } from "@/db/people";
import { listRoles, listUsers } from "@/lib/auth/admin";
import { readTokens } from "@/lib/auth/cookies";
import { hasPermission, requireUser } from "@/lib/auth/session";

// Always fresh: an admin may have just created or changed a user.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Users"
        description="You don't have permission to manage users. Ask an administrator for the user:admin role."
        icon={Lock}
      />
    );
  }

  const { access } = await readTokens();
  const [usersRes, rolesRes, people] = await Promise.all([
    listUsers(access ?? ""),
    listRoles(access ?? ""),
    getDirectoryPeople({ includeArchived: true }),
  ]);

  if (!usersRes.ok) {
    return (
      <PagePlaceholder
        title="Users"
        description={usersRes.error}
        icon={Users}
      />
    );
  }

  const roles = rolesRes.ok ? rolesRes.data : [];
  // Link logins to staff records by email (lowercased), for the directory column.
  const peopleByEmail: Record<string, { id: string; name: string }> = {};
  for (const p of people) {
    if (p.email) peopleByEmail[p.email.toLowerCase()] = { id: p.id, name: p.name };
  }

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <UsersTable
        users={usersRes.data}
        roles={roles}
        currentUserId={user.id}
        peopleByEmail={peopleByEmail}
      />
    </div>
  );
}
