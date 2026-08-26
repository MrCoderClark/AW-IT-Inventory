import { Suspense } from "react";
import { ChevronDown, Cpu, LayoutDashboard, Monitor, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { AssetTable } from "@/components/asset-table";
import { AssetDetailDrawer } from "@/components/asset-detail-drawer";
import { DonutChart } from "@/components/charts/donut-chart";
import { StatusBars } from "@/components/charts/status-bars";
import {
  getAssets,
  getDashboardStats,
  getMachineSummaries,
} from "@/db/queries";
import type { Kpi, Slice } from "@/lib/data";

export default async function DashboardPage() {
  const [assets, stats, machines] = await Promise.all([
    getAssets(),
    getDashboardStats(),
    getMachineSummaries(),
  ]);
  const t = stats.byType;
  const s = stats.byStatus;
  const total = stats.total || 1;

  const kpis: Kpi[] = [
    { label: "Total IT Assets", value: stats.total, sub: "across the fleet", icon: LayoutDashboard },
    { label: "Computers", value: t.Computer ?? 0, sub: "deployed & pool", icon: Cpu },
    { label: "Monitors", value: t.Monitor ?? 0, sub: "displays", icon: Monitor },
    {
      label: "Printers / Phones",
      value: (t.Printer ?? 0) + (t.Phone ?? 0),
      sub: "peripherals",
      icon: Smartphone,
    },
  ];

  const distribution: Slice[] = [
    { label: "Monitors", value: t.Monitor ?? 0, colorVar: "var(--chart-2)" },
    { label: "Computers", value: t.Computer ?? 0, colorVar: "var(--chart-1)" },
    { label: "Phones", value: t.Phone ?? 0, colorVar: "var(--chart-4)" },
    { label: "Printers", value: t.Printer ?? 0, colorVar: "var(--chart-3)" },
    { label: "Network", value: t.Network ?? 0, colorVar: "var(--chart-5)" },
  ].filter((slice) => slice.value > 0);

  const statusBreakdown = [
    {
      label: "Active",
      pct: Math.round((((s.deployed ?? 0) + (s.online ?? 0)) / total) * 100),
      colorVar: "var(--status-deployed)",
    },
    {
      label: "Maintenance",
      pct: Math.round(((s.maintenance ?? 0) / total) * 100),
      colorVar: "var(--status-maintenance)",
    },
    {
      label: "Storage",
      pct: Math.round(((s.storage ?? 0) / total) * 100),
      colorVar: "var(--status-storage)",
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-medium tracking-tight md:text-[26px]">
          IT Asset Management:{" "}
          <span className="font-extrabold">Overview &amp; Inventory</span>
        </h1>
        <Button variant="outline" className="ml-auto">
          Quick Actions
          <ChevronDown className="size-4" />
        </Button>
      </div>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} kpi={kpi} />
        ))}
      </section>

      <AssetTable assets={assets} />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Asset Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <DonutChart data={distribution} total={stats.total} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Asset Status</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBars data={statusBreakdown} />
          </CardContent>
        </Card>
      </section>

      <Suspense fallback={null}>
        <AssetDetailDrawer assets={assets} machines={machines} />
      </Suspense>
    </div>
  );
}
