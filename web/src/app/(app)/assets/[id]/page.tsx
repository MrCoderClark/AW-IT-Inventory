import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { AssetDetail } from "@/components/asset-detail";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getAssetById, getMachineSummary } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page({ params }: PageProps<"/assets/[id]">) {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Asset detail"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const { id } = await params;
  const asset = await getAssetById(id);
  if (!asset) notFound();

  const machine = await getMachineSummary(asset.id);

  return <AssetDetail asset={asset} machine={machine} />;
}
