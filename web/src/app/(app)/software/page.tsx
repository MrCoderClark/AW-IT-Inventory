import { Code2, Lock, Monitor, MonitorSmartphone, Tags } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { SoftwareInventory } from "@/components/software-inventory";
import { StatCard } from "@/components/dashboard/stat-card";
import { getSoftwareInventory, getSoftwareStats } from "@/db/software";
import { hasPermission, requireUser } from "@/lib/auth/session";

// The watchlist and its matches change on each scan or admin edit; read fresh.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  // Viewing is open to any asset:read user (spec 15, AC-4).
  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Software"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  // Managing the watchlist reuses scan:write (spec 15, AC-7).
  const canWrite = hasPermission(user, "scan:write");

  const [rows, stats] = await Promise.all([
    getSoftwareInventory(),
    getSoftwareStats(),
  ]);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <HeroHeader
        title="Software"
        subtitle="Track software titles across the fleet: computer counts, versions and publishers. Manage the watchlist here or on the Admin page."
        icon={<Code2 />}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={Tags}
          colorVar="var(--chart-1)"
          label="Total software titles"
          value={stats.titleCount}
          meta="on the watchlist"
        />
        <StatCard
          icon={Monitor}
          colorVar="var(--chart-2)"
          label="Total computers"
          value={stats.computerCount}
          meta="with tracked software installed"
        />
        <StatCard
          icon={MonitorSmartphone}
          colorVar="var(--chart-3)"
          label="Unique versions"
          value={stats.versionCount}
          meta="across all tracked software"
        />
      </div>

      <SoftwareInventory rows={rows} canWrite={canWrite} />
    </div>
  );
}
