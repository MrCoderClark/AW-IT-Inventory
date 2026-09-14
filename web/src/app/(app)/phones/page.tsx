import { Lock } from "lucide-react";

import { AssetTable, columnsFor } from "@/components/asset-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getAssetsByType } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Phones"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const assets = await getAssetsByType("Phone");

  return (
    <AssetTable
      assets={assets}
      config={{
        columns: columnsFor("Phone"),
        title: "Phones",
        emptyMessage: "No phones yet.",
      }}
    />
  );
}
