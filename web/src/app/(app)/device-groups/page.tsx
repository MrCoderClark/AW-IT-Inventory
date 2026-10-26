import { Lock } from "lucide-react";

import { DeviceGroupsView } from "@/components/device-groups-view";
import { PagePlaceholder } from "@/components/page-placeholder";
import { listDeviceGroups } from "@/db/device-groups";
import { getLocationOptions } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "software:deploy")) {
    return (
      <PagePlaceholder
        title="Device groups"
        description="You don't have permission to manage device groups. Ask an owner for the software:deploy role."
        icon={Lock}
      />
    );
  }

  const [groups, locations] = await Promise.all([
    listDeviceGroups(),
    getLocationOptions(),
  ]);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <DeviceGroupsView groups={groups} locations={locations} />
    </div>
  );
}
