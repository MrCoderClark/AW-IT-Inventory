import { Lock, RefreshCw } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { PatchesFleet } from "@/components/patches-fleet";
import { Card } from "@/components/ui/card";
import { getFleetPatches } from "@/db/patches";
import { hasPermission, requireUser } from "@/lib/auth/session";
import { cn } from "@/lib/utils";

function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "default" | "danger" | "warn" | "good" | "muted";
}) {
  const toneClass = {
    default: "text-foreground",
    danger: "text-destructive",
    warn: "text-status-maintenance",
    good: "text-positive",
    muted: "text-muted-foreground",
  }[tone];
  return (
    <Card className="gap-0 p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          "mt-2 text-2xl font-extrabold tracking-tight tabular-nums",
          toneClass,
        )}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
      {hint && <span className="mt-1 text-xs text-muted-foreground">{hint}</span>}
    </Card>
  );
}

export default async function Page() {
  const user = await requireUser();

  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Patches"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const rows = await getFleetPatches();
  const total = rows.length;
  const pendingReboot = rows.filter((r) => r.pendingReboot).length;
  const osMissing = rows.reduce((n, r) => n + (r.missingCount > 0 ? 1 : 0), 0);
  const staleOs = rows.filter(
    (r) => r.updatesLastDays != null && r.updatesLastDays > 30,
  ).length;
  const appWaiting = rows.reduce((n, r) => n + (r.appUpgradeCount > 0 ? 1 : 0), 0);
  const wingetMissing = rows.filter((r) => r.wingetAvailable === false).length;
  const neverCollected = rows.filter((r) => r.collectedAt == null).length;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <HeroHeader
        title="Patches"
        subtitle="Installed KBs, missing OS updates, pending reboot, and app upgrades — from scans and the daily Search job."
        icon={<RefreshCw />}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Pending reboot"
          value={pendingReboot}
          tone={pendingReboot > 0 ? "danger" : "good"}
          hint={`of ${total} computers`}
        />
        <StatTile
          label="OS updates missing"
          value={osMissing}
          tone={osMissing > 0 ? "danger" : "good"}
          hint="computers with ≥1"
        />
        <StatTile
          label="OS update 30+ days"
          value={staleOs}
          tone={staleOs > 0 ? "danger" : "good"}
        />
        <StatTile
          label="App upgrades waiting"
          value={appWaiting}
          tone={appWaiting > 0 ? "warn" : "good"}
          hint="computers with ≥1"
        />
        <StatTile
          label="Winget missing"
          value={wingetMissing}
          tone={wingetMissing > 0 ? "warn" : "muted"}
        />
        <StatTile
          label="Never collected"
          value={neverCollected}
          tone={neverCollected > 0 ? "warn" : "muted"}
          hint="need a Windows scan"
        />
      </section>

      <PatchesFleet
        rows={rows}
        canDeploy={hasPermission(user, "software:deploy")}
      />
    </div>
  );
}
