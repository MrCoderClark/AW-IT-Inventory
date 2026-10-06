import Link from "next/link";
import {
  Archive,
  CheckCircle2,
  LayoutDashboard,
  Lock,
  MapPin,
  Wrench,
} from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";
import { StatCard } from "@/components/dashboard/stat-card";
import { LiveClock } from "@/components/dashboard/live-clock";
import { RecentAlerts, type AlertItem } from "@/components/dashboard/recent-alerts";
import { LocationMap } from "@/components/dashboard/location-map";
import { DonutChart } from "@/components/charts/donut-chart";
import { BarChart } from "@/components/charts/bar-chart";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getAssetsByLocation,
  getDashboardStats,
  getDiscoveredDevices,
  getLocationMapPoints,
  getRecentAssets,
} from "@/db/queries";
import { getDashboardWidgetSettings } from "@/db/dashboard";
import { listNotifications } from "@/db/notifications";
import { hasPermission, requireUser } from "@/lib/auth/session";
import type { Slice } from "@/lib/data";

// KPIs, charts and alerts all read live from the fleet; never cache.
export const dynamic = "force-dynamic";

const SEVERITY_VAR: Record<string, string> = {
  critical: "var(--destructive)",
  warning: "var(--status-maintenance)",
  info: "var(--primary)",
};

function fmtUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A small header row for a dashboard card: title + an optional "View all" link. */
function CardHead({ title, href }: { title: string; href?: string }) {
  return (
    <div className="flex items-center justify-between border-b px-5 py-4">
      <h2 className="font-heading text-base font-semibold">{title}</h2>
      {href && (
        <Link
          href={href}
          className="text-sm font-medium text-primary hover:underline"
        >
          View all
        </Link>
      )}
    </div>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Dashboard"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const isAdmin = hasPermission(user, "user:admin");
  const userKey = user.id || user.email;

  const [stats, recent, byLocation, mapPoints, widgets, notifs, discovered] =
    await Promise.all([
      getDashboardStats(),
      getRecentAssets(8),
      getAssetsByLocation(6),
      getLocationMapPoints(),
      getDashboardWidgetSettings(),
      isAdmin
        ? listNotifications(userKey, { limit: 5 })
        : Promise.resolve({ items: [], nextBefore: null }),
      isAdmin
        ? Promise.resolve([])
        : getDiscoveredDevices({ includeIgnored: false }),
    ]);

  const s = stats.byStatus;
  const t = stats.byType;
  const total = stats.total;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const deployed = (s.deployed ?? 0) + (s.online ?? 0);
  const maintenance = s.maintenance ?? 0;
  const storage = s.storage ?? 0;

  // Recent Alerts: real notifications for admins (spec 19), recent discovered
  // devices for everyone else. Both map to the same list shape.
  const alerts: AlertItem[] = isAdmin
    ? notifs.items.map((n) => ({
        id: n.id,
        colorVar: SEVERITY_VAR[n.severity] ?? "var(--primary)",
        title: n.title,
        subtitle: n.body,
        at: n.createdAt,
        href: n.href,
      }))
    : discovered.slice(0, 5).map((d) => ({
        id: d.id,
        colorVar: "var(--primary)",
        title: "New device discovered",
        subtitle: d.hostname || d.ip || d.serial || "Unknown device",
        at: d.lastSeen,
        href: "/scans",
      }));

  // Donut: asset status (distinct colors so Online ≠ Deployed green), zeros dropped.
  const statusSlices: Slice[] = [
    { label: "Deployed", value: s.deployed ?? 0, colorVar: "var(--status-deployed)" },
    { label: "Online", value: s.online ?? 0, colorVar: "var(--chart-2)" },
    { label: "Maintenance", value: maintenance, colorVar: "var(--status-maintenance)" },
    { label: "Storage", value: storage, colorVar: "var(--status-storage)" },
  ].filter((x) => x.value > 0);

  // Bar: assets by type (fixed per-type colors, matching the type palette).
  const typeBars = [
    { label: "Computers", value: t.Computer ?? 0, colorVar: "var(--chart-1)" },
    { label: "Monitors", value: t.Monitor ?? 0, colorVar: "var(--chart-2)" },
    { label: "Printers", value: t.Printer ?? 0, colorVar: "var(--chart-3)" },
    { label: "Phones", value: t.Phone ?? 0, colorVar: "var(--chart-4)" },
    { label: "Network", value: t.Network ?? 0, colorVar: "var(--chart-5)" },
  ];

  // The map is an admin-toggleable widget: show it only when enabled and there is
  // at least one geocoded location; otherwise fall back to the location list.
  const showMap = widgets["locations-map"] && mapPoints.length > 0;
  const maxLocation = Math.max(1, ...byLocation.map((l) => l.count));

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Real-time visibility of your fleet, assignments and system health.
          </p>
        </div>
        <LiveClock />
      </div>

      {/* KPI row */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={LayoutDashboard}
          colorVar="var(--chart-1)"
          label="Total Assets"
          value={total}
          meta="across the fleet"
        />
        <StatCard
          icon={CheckCircle2}
          colorVar="var(--status-deployed)"
          label="In Use"
          value={deployed}
          meta={`${pct(deployed)}% of the fleet deployed`}
        />
        <StatCard
          icon={Wrench}
          colorVar="var(--status-maintenance)"
          label="Maintenance"
          value={maintenance}
          meta={`${pct(maintenance)}% of the fleet`}
        />
        <StatCard
          icon={Archive}
          colorVar="var(--status-storage)"
          label="In Storage"
          value={storage}
          meta={`${pct(storage)}% in the pool`}
        />
      </section>

      {/* Charts + alerts */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="gap-0 p-0 lg:col-span-1">
          <CardHead title="Asset Status" />
          <div className="p-5">
            {total > 0 ? (
              <DonutChart
                data={statusSlices}
                total={total}
                totalLabel="Total Assets"
                showValues
              />
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No assets yet.
              </p>
            )}
          </div>
        </Card>

        <Card className="gap-0 p-0 lg:col-span-1">
          <CardHead title="Assets by Type" />
          <div className="p-5">
            <BarChart data={typeBars} />
          </div>
        </Card>

        <Card className="gap-0 p-0 lg:col-span-1">
          <CardHead
            title="Recent Alerts"
            href={isAdmin ? "/notifications" : "/scans"}
          />
          <div className="px-5 py-2">
            <RecentAlerts
              items={alerts}
              emptyMessage={
                isAdmin ? "You're all caught up." : "No new devices discovered."
              }
            />
          </div>
        </Card>
      </section>

      {/* Recent assets + locations */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="gap-0 p-0 lg:col-span-2">
          <CardHead title="Recent Assets" href="/computers" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No assets yet.
                  </TableCell>
                </TableRow>
              ) : (
                recent.map((a) => (
                  <TableRow key={a.tag} className="group">
                    <TableCell className="font-mono text-xs font-semibold">
                      {a.tag}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/assets/${a.tag}`}
                        className="font-medium hover:underline"
                      >
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {a.type}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {a.location || "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                      {fmtUpdated(a.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>

        <Card className="gap-0 p-0 lg:col-span-1">
          <CardHead title="Asset Locations" href="/locations" />
          {showMap ? (
            <div className="p-3">
              <LocationMap points={mapPoints} />
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 px-2">
                {statusSlices.map((s2) => (
                  <span
                    key={s2.label}
                    className="inline-flex items-center gap-1.5 text-xs"
                  >
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: s2.colorVar }}
                    />
                    <span className="text-muted-foreground">{s2.label}</span>
                    <span className="font-semibold tabular-nums">
                      {s2.value.toLocaleString()}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-5">
              {byLocation.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No devices assigned to a location yet.
                </p>
              ) : (
                byLocation.map((l) => (
                <div key={l.id}>
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{l.name}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {l.count}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(l.count / maxLocation) * 100}%` }}
                    />
                  </div>
                </div>
              ))
              )}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
