import { Lock } from "lucide-react";

import { PeopleDirectory } from "@/components/people-directory";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getDirectoryPeople } from "@/db/people";
import { getLocationOptions } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

// The directory and its device counts change on each assignment or edit; read fresh.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  // Viewing is open to any asset:read user (spec 16, AC-10).
  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="People"
        description="You don't have permission to view the directory. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const canWrite = hasPermission(user, "asset:write");
  // Load everyone (both statuses); the client filters active/archived and search.
  const [people, locations] = await Promise.all([
    getDirectoryPeople({ includeArchived: true }),
    // A person may sit at any location node, so all options (not leaf-only).
    canWrite ? getLocationOptions() : Promise.resolve([]),
  ]);

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
      />
    </div>
  );
}
