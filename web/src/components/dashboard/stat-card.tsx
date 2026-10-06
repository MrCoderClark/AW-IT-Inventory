import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";

/**
 * A dashboard KPI tile (spec: dashboard redesign). A colored icon tile, a label,
 * a big number, and a factual meta line (e.g. share of the fleet). Unlike the
 * mock's "↑4% vs last 30 days", OPUS keeps no historical snapshots, so the meta
 * is a real computed figure, never a fabricated trend.
 */
export function StatCard({
  icon: Icon,
  colorVar,
  label,
  value,
  meta,
}: {
  icon: LucideIcon;
  colorVar: string;
  label: string;
  value: number;
  meta: string;
}) {
  return (
    <Card className="gap-0 p-5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="grid size-11 shrink-0 place-items-center rounded-xl [&_svg]:size-5"
          style={{
            backgroundColor: `color-mix(in oklch, ${colorVar}, transparent 86%)`,
            color: colorVar,
          }}
        >
          <Icon />
        </span>
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="mt-3 text-3xl font-extrabold tracking-tight tabular-nums">
        {value.toLocaleString()}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">{meta}</div>
    </Card>
  );
}
