import { Lock } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";
import { ScanJobsView } from "@/components/scan-jobs-view";
import { listScanJobs } from "@/db/scan";
import { hasPermission, requireUser } from "@/lib/auth/session";

// Always fetch fresh: the queue changes as the worker drains it (AC-5).
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "scan:read")) {
    return (
      <PagePlaceholder
        title="Scan jobs"
        description="You don't have permission to view scans. Ask an admin for the scan:read role."
        icon={Lock}
      />
    );
  }

  const canScan = hasPermission(user, "scan:write");
  const jobs = await listScanJobs();

  return <ScanJobsView jobs={jobs} canScan={canScan} />;
}
