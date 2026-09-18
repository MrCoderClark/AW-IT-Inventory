import { Lock } from "lucide-react";

import { LocationTree } from "@/components/location-tree";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getLocationOptions, getLocationTree } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Locations"
        description="You don't have permission to view locations. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const canWrite = hasPermission(user, "location:write");
  const [tree, options] = await Promise.all([
    getLocationTree(),
    getLocationOptions(),
  ]);

  return <LocationTree tree={tree} options={options} canWrite={canWrite} />;
}
