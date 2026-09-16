import { Lock } from "lucide-react";

import { AssetTable } from "@/components/asset-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getAssetsByType } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page() {
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

  const assets = await getAssetsByType("Printer");

  return (
    <AssetTable
      assets={assets}
      config={{
        type: "Printer",
        title: "Printers",
        emptyMessage: "No printers yet.",
      }}
    />
  );
}
