import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { ComputerDetail } from "@/components/computer-detail";
import { PrinterDetail } from "@/components/printer-detail";
import { ThinAssetDetail } from "@/components/thin-detail";
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

  // Computers get the redesigned, tabbed detail (spec 17.04): spec-10 fields, live
  // scan health, tracked software (spec 15), and assignment (spec 16) move into tabs.
  if (asset.type === "Computer") {
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
      getInstalledSoftware(id),
      getAssetAssignmentHistory(id),
    ]);
    return (
      <ComputerDetail
        asset={asset}
        machine={machine}
        details={assetDetails?.row ?? null}
        software={software}
        assignmentHistory={assignmentHistory}
        assigneeId={assigneeId ?? null}
        people={people}
        locations={locations}
        canWrite={canWrite}
        canScan={canScan}
      />
    );
  }

  // Thin categories (monitor / phone / network): the shared tabbed detail (spec
  // 17.05). Monitors/phones carry assignment; network carries only its own fields.
  const [assigneeId, people, locations, assetDetails, assignmentHistory] =
    await Promise.all([
      canWrite ? getAssetAssigneeId(id) : Promise.resolve(null),
      canWrite ? getPeople() : Promise.resolve([]),
      canWrite ? getLeafLocationOptions() : Promise.resolve([]),
      getAssetDetails(id),
      // Assignment history (spec 16, AC-7); empty for never-assigned / network gear.
      getAssetAssignmentHistory(id),
    ]);

  return (
    <ThinAssetDetail
      asset={asset}
      details={assetDetails?.row ?? null}
      assignmentHistory={assignmentHistory}
      assigneeId={assigneeId ?? null}
      people={people}
      locations={locations}
      canWrite={canWrite}
    />
  );
}
