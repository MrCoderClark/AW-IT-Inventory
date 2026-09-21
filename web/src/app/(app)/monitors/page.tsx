import { Lock } from "lucide-react";

import { AssetTable } from "@/components/asset-table";
import { PagePlaceholder } from "@/components/page-placeholder";
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
  const [assets, people, locations, columnOrder] = await Promise.all([
    getAssetsByType("Monitor", { locationId: loc }),
    canWrite ? getPeople() : Promise.resolve([]),
    getLocationOptions(),
    getColumnConfig("monitor"),
  ]);

  return (
    <AssetTable
      assets={assets}
      config={{
        type: "Monitor",
        view: "monitor",
        columnOrder,
        title: "Monitors",
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
