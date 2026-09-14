import { Lock } from "lucide-react";

import { DiscoveredInbox } from "@/components/discovered-inbox";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getDiscoveredDevices, getLinkAssets } from "@/db/queries";
import { hasPermission, requireUser } from "@/lib/auth/session";

export default async function Page({
  searchParams,
}: PageProps<"/scans">) {
  const user = await requireUser();

  if (!hasPermission(user, "scan:read")) {
    return (
      <PagePlaceholder
        title="Scans & Discovery"
        description="You don't have permission to view scan data. Ask an admin for the scan:read role."
        icon={Lock}
      />
    );
  }

  const { view: rawView } = await searchParams;
  const view = rawView === "ignored" ? "ignored" : "inbox";
  const canWrite = hasPermission(user, "asset:write");

  const [devices, assets] = await Promise.all([
    getDiscoveredDevices({ includeIgnored: view === "ignored" }),
    view === "inbox" ? getLinkAssets() : Promise.resolve([]),
  ]);

  return (
    <DiscoveredInbox
      devices={devices}
      assets={assets}
      view={view}
      canWrite={canWrite}
    />
  );
}
