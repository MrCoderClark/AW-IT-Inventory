"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MonitorUp, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { dismissDiscoveredMonitor } from "@/app/(app)/monitor-discovery-actions";
import {
  AssetFormDialog,
  type PersonOption,
} from "@/components/asset-form-dialog";
import { Button } from "@/components/ui/button";
import { EMPTY_ASSET_FORM, type AssetFormValues } from "@/lib/asset-schema";
import type { DetailsFormValues } from "@/lib/asset-fields";
import type { LocationOption } from "@/lib/data";

/** One discoverable display, as the store returns it (serial guaranteed). */
export type DiscoveredMonitorItem = {
  serial: string;
  manufacturer: string | null;
  vendorCode: string | null;
  model: string | null;
  productCode: string | null;
  year: number | null;
  diagonalIn: number | null;
  resolution: string | null;
  refreshHz: number | null;
  computerTag: string;
  computerName: string;
};

/**
 * "Discovered displays" banner on /monitors (spec 25 follow-up): displays a scan
 * found that aren't Monitor assets yet. Each offers a one-click **Add to
 * inventory** (opens the New Monitor dialog pre-filled from the EDID) and a
 * **Dismiss** (hides built-in laptop panels, docks, and other noise). Renders
 * nothing when there's nothing to discover, so the page is clean once triaged.
 */
export function DiscoveredMonitors({
  monitors,
  people = [],
  locations = [],
  canWrite = false,
}: {
  monitors: DiscoveredMonitorItem[];
  people?: PersonOption[];
  locations?: LocationOption[];
  canWrite?: boolean;
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = React.useState(false);
  const [seed, setSeed] = React.useState<{
    initial: AssetFormValues;
    details: DetailsFormValues;
  } | null>(null);
  const [dismissing, setDismissing] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  if (monitors.length === 0) return null;

  function openAdd(m: DiscoveredMonitorItem) {
    setSeed({
      initial: {
        ...EMPTY_ASSET_FORM,
        name: m.model || m.manufacturer || "Monitor",
        type: "Monitor",
        status: "storage",
        serial: m.serial,
        model: m.model ?? "",
        vendor: m.manufacturer ?? "",
      },
      details: {
        sizeInches: m.diagonalIn != null ? String(m.diagonalIn) : "",
        resolution: m.resolution ?? "",
        refreshHz: m.refreshHz != null ? String(m.refreshHz) : "",
      },
    });
    setAddOpen(true);
  }

  function dismiss(m: DiscoveredMonitorItem) {
    setDismissing(m.serial);
    startTransition(async () => {
      const res = await dismissDiscoveredMonitor(m.serial);
      setDismissing(null);
      if (res.ok) {
        toast.success(res.message ?? "Display dismissed.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="rounded-xl border border-accent-soft bg-accent-soft/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-accent-soft text-primary">
          <MonitorUp className="size-4" />
        </span>
        <h2 className="text-sm font-bold">
          Discovered displays
          <span className="ml-1.5 font-normal text-muted-foreground">
            · {monitors.length} not in inventory
          </span>
        </h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Monitors a scan read from a computer&apos;s EDID that aren&apos;t tracked
        yet. Add the real ones; dismiss built-in panels, docks, and duplicates.
      </p>

      <ul className="divide-y divide-border/60 rounded-lg border bg-background">
        {monitors.map((m) => (
          <li
            key={m.serial}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {m.model || m.manufacturer || "Display"}
              </div>
              <div className="text-xs text-muted-foreground">
                {[
                  m.manufacturer,
                  m.year ? `${m.year}` : null,
                  m.diagonalIn ? `${m.diagonalIn}"` : null,
                  m.resolution,
                  m.refreshHz ? `${m.refreshHz} Hz` : null,
                  `seen on ${m.computerName}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {m.serial}
              </span>
              {canWrite && (
                <>
                  <Button size="sm" onClick={() => openAdd(m)}>
                    <Plus className="size-4" /> Add to inventory
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => dismiss(m)}
                    disabled={dismissing === m.serial}
                    aria-label={`Dismiss ${m.model || m.serial}`}
                  >
                    <X className="size-4" /> Dismiss
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {canWrite && (
        <AssetFormDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          mode="create"
          presetType="Monitor"
          people={people}
          locations={locations}
          initial={seed?.initial}
          initialDetails={seed?.details}
          onSuccess={() => router.refresh()}
        />
      )}
    </div>
  );
}
