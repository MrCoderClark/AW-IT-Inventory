import { Suspense } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { AssetTable } from "@/components/asset-table";
import { AssetDetailDrawer } from "@/components/asset-detail-drawer";
import { DonutChart } from "@/components/charts/donut-chart";
import { StatusBars } from "@/components/charts/status-bars";
import { KPIS, DISTRIBUTION, STATUS_BREAKDOWN } from "@/lib/data";

export default function DashboardPage() {
  const totalAssets = DISTRIBUTION.reduce((a, s) => a + s.value, 0);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      {/* Page head */}
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

      {/* KPIs */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPIS.map((kpi) => (
          <KpiCard key={kpi.label} kpi={kpi} />
        ))}
      </section>

      {/* Inventory table */}
      <AssetTable />

      {/* Analytics */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Asset Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <DonutChart data={DISTRIBUTION} total={totalAssets} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Asset Status</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBars data={STATUS_BREAKDOWN} />
          </CardContent>
        </Card>
      </section>

      <Suspense fallback={null}>
        <AssetDetailDrawer />
      </Suspense>
    </div>
  );
}
