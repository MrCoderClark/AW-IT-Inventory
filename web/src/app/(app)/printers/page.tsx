import { Lock } from "lucide-react";

import { AssetTable } from "@/components/asset-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getAssetsByType, getLocationOptions, getPeople } from "@/db/queries";
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
  const [assets, people, locations] = await Promise.all([
    getAssetsByType("Printer", { locationId: loc }),
    canWrite ? getPeople() : Promise.resolve([]),
    getLocationOptions(),
  ]);

  return (
    <AssetTable
      assets={assets}
      config={{
        type: "Printer",
        title: "Printers",
        emptyMessage: "No printers yet.",
      }}
      canWrite={canWrite}
      people={people}
      locations={locations}
      activeLocationId={loc}
    />
  );
}
