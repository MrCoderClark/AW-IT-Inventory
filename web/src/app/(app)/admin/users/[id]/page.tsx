import { Lock, Users } from "lucide-react";

import { UserDetail } from "@/components/user-detail";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getPersonByEmail } from "@/db/people";
import { getUser, listRoles } from "@/lib/auth/admin";
import { readTokens } from "@/lib/auth/cookies";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Page(props: PageProps<"/admin/users/[id]">) {
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

  const { id } = await props.params;
  const { access } = await readTokens();
  const [targetRes, rolesRes] = await Promise.all([
    getUser(access ?? "", id),
    listRoles(access ?? ""),
  ]);

  if (!targetRes.ok) {
    return (
      <PagePlaceholder
        title="User not found"
        description={targetRes.error}
        icon={Users}
      />
    );
  }

  // Link to the staff directory by email (no stored FK; matched on email).
  const linkedPerson = await getPersonByEmail(targetRes.data.email);

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6">
      <UserDetail
        target={targetRes.data}
        roles={rolesRes.ok ? rolesRes.data : []}
        isSelf={targetRes.data.id === user.id}
        linkedPerson={linkedPerson}
      />
    </div>
  );
}
