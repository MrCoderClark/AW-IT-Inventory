import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { PersonDetail } from "@/components/person-detail";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getPersonAssignments } from "@/db/assignments";
import { getPersonById } from "@/db/people";
import { getAssignableAssets, getLocationOptions } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

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

  return (
    <PersonDetail
      person={person}
      currentDevices={currentDevices}
      history={history}
      assignableAssets={assignableAssets}
      canWrite={canWrite}
      locations={locations}
    />
  );
}
