import type { AssetReachability, ReachabilityState } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * The printer reachability badge (spec 12, AC-8): a colored dot plus label for
 * the current up/down/unknown state. Shown on the printers table and the printer
 * detail page. Pure/props-only so it renders on the server or client.
 */

const META: Record<ReachabilityState, { label: string; colorVar: string }> = {
  up: { label: "Reachable", colorVar: "var(--status-online)" },
  down: { label: "Down", colorVar: "var(--status-maintenance)" },
  unknown: { label: "Not checked", colorVar: "var(--muted-foreground)" },
};

export function ReachabilityBadge({
  reachability,
  className,
}: {
  reachability?: AssetReachability | null;
  className?: string;
}) {
  const state: ReachabilityState = reachability?.state ?? "unknown";
  const meta = META[state];
  return (
    <span
      className={cn("inline-flex items-center gap-2 text-sm font-medium", className)}
      style={{ color: meta.colorVar }}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          state === "down" && "animate-pulse",
        )}
        style={{ backgroundColor: meta.colorVar }}
      />
      {meta.label}
    </span>
  );
}
