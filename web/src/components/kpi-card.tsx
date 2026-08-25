import { ArrowUpRight } from "lucide-react";

import { Card } from "@/components/ui/card";
import type { Kpi } from "@/lib/data";

export function KpiCard({ kpi }: { kpi: Kpi }) {
  const Icon = kpi.icon;
  return (
    <Card className="gap-0 p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">
          {kpi.label}
        </span>
        <span className="grid size-9 place-items-center rounded-lg bg-accent text-primary">
          <Icon className="size-[18px]" />
        </span>
      </div>
      <div className="mt-3 text-3xl font-extrabold tracking-tight tabular-nums">
        {kpi.value.toLocaleString()}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        {kpi.delta !== undefined && (
          <span className="inline-flex items-center gap-0.5 font-semibold text-positive">
            <ArrowUpRight className="size-3.5" />
            {kpi.delta}%
          </span>
        )}
        {kpi.sub}
      </div>
    </Card>
  );
}
