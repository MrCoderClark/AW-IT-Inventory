import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { AssetDetail } from "@/components/asset-detail";
import { PagePlaceholder } from "@/components/page-placeholder";
import {
  getAssetAssigneeId,
  getAssetById,
  getAssetDetails,
  getLeafLocationOptions,
  getMachineSummary,
  getPeople,
} from "@/db/queries";
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
  const canWrite = hasPermission(user, "asset:write");
  // All key off the same route tag, so fetch them together.
  const [asset, machine, assigneeId, people, locations, assetDetails] =
    await Promise.all([
      getAssetById(id),
      getMachineSummary(id),
      canWrite ? getAssetAssigneeId(id) : Promise.resolve(null),
      canWrite ? getPeople() : Promise.resolve([]),
      canWrite ? getLeafLocationOptions() : Promise.resolve([]),
      getAssetDetails(id),
    ]);
  if (!asset) notFound();

  return (
    <AssetDetail
      asset={asset}
      machine={machine}
      canWrite={canWrite}
      people={people}
      locations={locations}
      details={assetDetails?.row ?? null}
      assigneeId={assigneeId ?? null}
    />
  );
}
