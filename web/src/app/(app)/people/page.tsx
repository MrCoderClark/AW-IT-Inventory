import { Lock } from "lucide-react";

import { PeopleDirectory } from "@/components/people-directory";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getDirectoryPeople } from "@/db/people";
import { getLocationOptions } from "@/db/queries";
import { listUsers } from "@/lib/auth/admin";
import { readTokens } from "@/lib/auth/cookies";
import { hasPermission, requireUser } from "@/lib/auth/session";

// The directory and its device counts change on each assignment or edit; read fresh.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  // The staff directory (contact details, employee IDs, per-person device lists)
  // is restricted to users who manage inventory — asset:write (RBAC audit). A
  // read-only viewer still sees device→person assignments on the asset pages.
  if (!hasPermission(user, "asset:write")) {
    return (
      <PagePlaceholder
        title="People"
        description="You don't have permission to view the staff directory. Ask an admin for the asset:write role."
        icon={Lock}
      />
    );
  }

  const canWrite = hasPermission(user, "asset:write");
  const canManageUsers = hasPermission(user, "user:admin");
  // Load everyone (both statuses); the client filters active/archived and search.
  const [people, locations] = await Promise.all([
    getDirectoryPeople({ includeArchived: true }),
    // A person may sit at any location node, so all options (not leaf-only).
    canWrite ? getLocationOptions() : Promise.resolve([]),
  ]);

  // Admins get a "Login" badge on people who have an OPUS account (by email).
  let loginEmails: string[] = [];
  if (canManageUsers) {
    const { access } = await readTokens();
    const usersRes = await listUsers(access ?? "");
    if (usersRes.ok) {
      loginEmails = usersRes.data.map((u) => u.email.toLowerCase());
    }
  }

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">People</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The staff who use the fleet. Assign devices to real people and track who
          holds what, and who held it before.
        </p>
      </div>

      <PeopleDirectory
        people={people}
        canWrite={canWrite}
        locations={locations}
        loginEmails={loginEmails}
      />
    </div>
  );
}
