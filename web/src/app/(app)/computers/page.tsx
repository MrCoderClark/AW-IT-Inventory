import { Cpu, Lock } from "lucide-react";

import { AssetTable } from "@/components/asset-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import {
  getAssetsByType,
  getColumnConfig,
  getLocationOptions,
  getPeople,
} from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page({
  searchParams,
}: PageProps<"/computers">) {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Computers"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const { loc: rawLoc } = await searchParams;
  const loc = typeof rawLoc === "string" ? rawLoc : undefined;
  const canWrite = hasPermission(user, "asset:write");
  const canConfigureColumns = hasPermission(user, "columns:write");
  const canScan = hasPermission(user, "scan:write");
  const [assets, people, locations, columnOrder] = await Promise.all([
    getAssetsByType("Computer", { locationId: loc }),
    canWrite ? getPeople() : Promise.resolve([]),
    getLocationOptions(),
    getColumnConfig("computer"),
  ]);

  return (
    <AssetTable
      assets={assets}
      config={{
        type: "Computer",
        view: "computer",
        columnOrder,
        title: "Computers",
        subtitle: "Manage and view all computer assets in your organization.",
        icon: <Cpu />,
        // New list layout (spec 17.04, AC-4.1): restyled header (no photo hero),
        // the type's filters, and a "New Computer" button.
        showStatusFilter: true,
        showVendorFilter: true,
        showModelFilter: true,
        createLabel: "New Computer",
        emptyMessage: "No computers yet.",
      }}
      canWrite={canWrite}
      canConfigureColumns={canConfigureColumns}
      canScan={canScan}
      people={people}
      locations={locations}
      activeLocationId={loc}
    />
  );
}
