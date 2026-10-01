import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { AssetDetail } from "@/components/asset-detail";
import { PrinterDetail } from "@/components/printer-detail";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getAssetAssignmentHistory } from "@/db/assignments";
import { getPrinterCounters } from "@/db/counters";
import { getInstalledSoftware } from "@/db/software";
import { getPrinterActivity, getPrinterNetworkHealth } from "@/db/printers";
import {
  getAssetAssigneeId,
  getAssetById,
  getAssetDetails,
  getLeafLocationOptions,
  getMachineSummary,
  getPeople,
  getPrinterReachability,
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
  const canScan = hasPermission(user, "scan:write");

  const asset = await getAssetById(id);
  if (!asset) notFound();

  // Printers get the redesigned, tabbed detail page (spec 17.03); every other
  // type keeps the generic detail component until child 04 rolls the framework out.
  if (asset.type === "Printer") {
    const [details, reachability, networkHealth, counters, activity, locations] =
      await Promise.all([
        getAssetDetails(id),
        getPrinterReachability(id),
        getPrinterNetworkHealth(id),
        getPrinterCounters(id),
        getPrinterActivity(id, 20),
        canWrite ? getLeafLocationOptions() : Promise.resolve([]),
      ]);
    return (
      <PrinterDetail
        asset={asset}
        details={details?.row ?? null}
        reachability={reachability}
        networkHealth={networkHealth}
        counters={counters}
        activity={activity}
        canWrite={canWrite}
        canScan={canScan}
        locations={locations}
      />
    );
  }

  // Non-printer assets: the generic detail. All key off the same route tag, so
  // fetch them together.
  const [
    machine,
    assigneeId,
    people,
    locations,
    assetDetails,
    software,
    assignmentHistory,
  ] = await Promise.all([
    getMachineSummary(id),
    canWrite ? getAssetAssigneeId(id) : Promise.resolve(null),
    canWrite ? getPeople() : Promise.resolve([]),
    canWrite ? getLeafLocationOptions() : Promise.resolve([]),
    getAssetDetails(id),
    // Tracked-software panel (spec 15, AC-6); empty for non-computers.
    getInstalledSoftware(id),
    // Assignment history panel (spec 16, AC-7); empty for never-assigned devices.
    getAssetAssignmentHistory(id),
  ]);

  return (
    <AssetDetail
      asset={asset}
      machine={machine}
      canWrite={canWrite}
      canScan={canScan}
      people={people}
      locations={locations}
      details={assetDetails?.row ?? null}
      assigneeId={assigneeId ?? null}
      reachability={null}
      counters={null}
      software={software}
      assignmentHistory={assignmentHistory}
    />
  );
}
