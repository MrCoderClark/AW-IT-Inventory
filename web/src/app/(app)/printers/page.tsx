import { Lock, Printer } from "lucide-react";

import { AssetTable } from "@/components/asset-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import {
  getAssetsByType,
  getColumnConfig,
  getLocationOptions,
  getPeople,
} from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page({ searchParams }: PageProps<"/printers">) {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Printers"
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
    getAssetsByType("Printer", { locationId: loc }),
    canWrite ? getPeople() : Promise.resolve([]),
    getLocationOptions(),
    getColumnConfig("printer"),
  ]);

  return (
    <AssetTable
      assets={assets}
      config={{
        type: "Printer",
        view: "printer",
        columnOrder,
        title: "Printers",
        subtitle: "Manage and view all printer assets in your organization.",
        icon: <Printer />,
        backgroundImage: "/heroes/printers.png",
        // Match the mock: Manufacturer / Model / Location filters, no Status
        // dropdown, and a "New Printer" button (spec 17.03, AC-3.1, AC-3.2).
        showVendorFilter: true,
        showModelFilter: true,
        showStatusFilter: false,
        createLabel: "New Printer",
        emptyMessage: "No printers yet.",
      }}
      canWrite={canWrite}
      canConfigureColumns={canConfigureColumns}
      people={people}
      locations={locations}
      activeLocationId={loc}
    />
  );
}
