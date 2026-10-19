import { Lock, Monitor } from "lucide-react";

import { AssetTable } from "@/components/asset-table";
import { DiscoveredMonitors } from "@/components/discovered-monitors";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getDiscoveredMonitors } from "@/db/monitors";
import {
  getAssetsByType,
  getColumnConfig,
  getLocationOptions,
  getPeople,
} from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page({ searchParams }: PageProps<"/monitors">) {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Monitors"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const { loc: rawLoc } = await searchParams;
  const loc = typeof rawLoc === "string" ? rawLoc : undefined;
  const canWrite = hasPermission(user, "asset:write");
  const canConfigureColumns = hasPermission(user, "columns:write");
  const [assets, people, locations, columnOrder, discovered] = await Promise.all([
    getAssetsByType("Monitor", { locationId: loc }),
    canWrite ? getPeople() : Promise.resolve([]),
    getLocationOptions(),
    getColumnConfig("monitor"),
    // Displays a scan read but that aren't Monitor assets yet (spec 25 follow-up).
    getDiscoveredMonitors(),
  ]);

  return (
    <AssetTable
      assets={assets}
      banner={
        <DiscoveredMonitors
          key="discovered-monitors"
          monitors={discovered}
          people={people}
          locations={locations}
          canWrite={canWrite}
        />
      }
      config={{
        type: "Monitor",
        view: "monitor",
        columnOrder,
        title: "Monitors",
        subtitle: "Manage and view all monitor assets in your organization.",
        icon: <Monitor />,
        backgroundImage: "/heroes/monitors.png",
        showStatusFilter: true,
        showVendorFilter: true,
        showModelFilter: true,
        createLabel: "New Monitor",
        emptyMessage: "No monitors yet.",
      }}
      canWrite={canWrite}
      canConfigureColumns={canConfigureColumns}
      people={people}
      locations={locations}
      activeLocationId={loc}
    />
  );
}
