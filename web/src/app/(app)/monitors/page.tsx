import { Lock } from "lucide-react";

import { AssetTable } from "@/components/asset-table";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getAssetsByType, getPeople } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page() {
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

  const canWrite = hasPermission(user, "asset:write");
  const [assets, people] = await Promise.all([
    getAssetsByType("Monitor"),
    canWrite ? getPeople() : Promise.resolve([]),
  ]);

  return (
    <AssetTable
      assets={assets}
      config={{
        type: "Monitor",
        title: "Monitors",
        emptyMessage: "No monitors yet.",
      }}
      canWrite={canWrite}
      people={people}
    />
  );
}
