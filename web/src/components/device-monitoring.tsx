import { Activity } from "lucide-react";

import { Card } from "@/components/ui/card";
import type { DeviceMetrics, MetricPoint } from "@/db/metrics";
import { cn } from "@/lib/utils";

/**
 * Device monitoring (spec 29): CPU / RAM / disk sparklines over the last 24 h plus
 * the latest reading, from the worker's metric samples. Pure/server-safe — renders
 * on the computer detail page. Each metric is a thin single-hue sparkline with a
 * direct latest-value label; an empty state shows until the first sample lands.
 */
export function DeviceMonitoring({ metrics }: { metrics: DeviceMetrics }) {
  if (!metrics.latest || metrics.points.length === 0) {
    return (
      <Card className="items-center gap-2 p-8 text-center">
        <Activity className="size-7 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No telemetry yet. Once the collector worker is sampling this computer,
          CPU / memory / disk trends appear here (every ~15 min).
        </p>
      </Card>
    );
  }

  const l = metrics.latest;
  const rows: {
    key: "cpuPct" | "memPct" | "diskPct";
    label: string;
    value: number | null;
    colorVar: string;
  }[] = [
    { key: "cpuPct", label: "CPU", value: l.cpuPct, colorVar: "var(--chart-1)" },
    { key: "memPct", label: "Memory", value: l.memPct, colorVar: "var(--chart-2)" },
    { key: "diskPct", label: "System disk", value: l.diskPct, colorVar: "var(--chart-3)" },
  ];

  return (
    <Card className="gap-0 p-0">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="font-heading text-base font-semibold">Monitoring</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Last 24 hours · {metrics.points.length} sample
            {metrics.points.length === 1 ? "" : "s"}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          Uptime {formatUptime(l.uptimeSec)} · updated {formatWhen(l.sampledAt)}
        </span>
      </div>
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-4 px-5 py-4">
            <div className="w-24 shrink-0">
              <div className="text-sm font-medium">{r.label}</div>
              <div
                className="text-2xl font-extrabold tabular-nums"
                style={{ color: r.value != null ? r.colorVar : undefined }}
              >
                {r.value != null ? `${Math.round(r.value)}%` : "—"}
              </div>
            </div>
            <Sparkline
              points={metrics.points}
              field={r.key}
              colorVar={r.colorVar}
              className="min-w-0 flex-1"
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A thin 0–100% sparkline from the metric points; gaps (null) break the line. */
function Sparkline({
  points,
  field,
  colorVar,
  className,
}: {
  points: MetricPoint[];
  field: "cpuPct" | "memPct" | "diskPct";
  colorVar: string;
  className?: string;
}) {
  const W = 240;
  const H = 40;
  const n = points.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (Math.max(0, Math.min(100, v)) / 100) * H;

  // Build path segments, breaking on gaps so a null doesn't draw to zero.
  let d = "";
  let pendingMove = true;
  points.forEach((p, i) => {
    const v = p[field];
    if (v == null) {
      pendingMove = true;
      return;
    }
    d += `${pendingMove ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    pendingMove = false;
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("h-10 w-full", className)}
      aria-hidden
    >
      {/* 50% / 100% guide lines, recessive. */}
      <line x1="0" y1={y(100)} x2={W} y2={y(100)} className="stroke-border" strokeWidth="1" />
      <line x1="0" y1={y(50)} x2={W} y2={y(50)} className="stroke-border/60" strokeWidth="1" strokeDasharray="3 3" />
      <path d={d.trim()} fill="none" stroke={colorVar} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function formatUptime(sec: number | null): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3_600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}
