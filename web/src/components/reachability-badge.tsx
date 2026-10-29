import type { AssetReachability, ReachabilityState } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * The printer reachability badge (spec 12, AC-8): a colored dot plus label for
 * the current up/down/unknown state, with an error flag indicator when the SNMP
 * error state reports active errors. Shown on the printers table and the printer
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
  const errors = reachability?.errors ?? [];
  const hasErrors = errors.length > 0;
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm font-medium", className)}>
      <span
        className="inline-flex items-center gap-2"
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
      {hasErrors && (
        <span
          className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold"
          style={{
            color: "var(--status-maintenance)",
            backgroundColor:
              "color-mix(in oklch, var(--status-maintenance), transparent 88%)",
          }}
          title={errors.map(humanError).join(", ")}
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="currentColor"
            className="size-3"
          >
            <path d="M8 1a.75.75 0 0 1 .67.42l6.25 12.5A.75.75 0 0 1 14.25 15H1.75a.75.75 0 0 1-.67-1.08l6.25-12.5A.75.75 0 0 1 8 1Zm0 4.5a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.5ZM8 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
          </svg>
          {errors.length}
        </span>
      )}
    </span>
  );
}

/** Human labels for the camelCase error flag names. */
const ERROR_LABELS: Record<string, string> = {
  lowPaper: "Low paper",
  noPaper: "No paper",
  lowToner: "Low toner",
  noToner: "No toner",
  doorOpen: "Door open",
  jammed: "Paper jam",
  offline: "Offline",
  serviceRequested: "Service required",
  inputTrayMissing: "Input tray missing",
  outputTrayMissing: "Output tray missing",
  markerSupplyMissing: "Marker supply missing",
  outputNearFull: "Output near full",
  outputFull: "Output full",
  inputTrayEmpty: "Input tray empty",
  overduePreventMaint: "Overdue maintenance",
};

export function humanError(flag: string): string {
  return ERROR_LABELS[flag] ?? flag;
}
