"use client";

import * as React from "react";
import { Loader2, Map } from "lucide-react";
import { toast } from "sonner";

import { setDashboardWidgetAction } from "@/app/(app)/dashboard-actions";
import { Switch } from "@/components/ui/switch";
import type { DashboardWidgetId, DashboardWidgetSettings } from "@/db/dashboard";

const WIDGET_META: Record<
  DashboardWidgetId,
  { label: string; hint: string; icon: React.ComponentType<{ className?: string }> }
> = {
  "locations-map": {
    label: "Asset Locations map",
    hint: "Show the interactive map on the dashboard. When off, a simple location list is shown instead.",
    icon: Map,
  },
};

const ORDER: DashboardWidgetId[] = ["locations-map"];

/**
 * The dashboard widget switches on the Admin page. Each flips one widget on or off
 * through the `scan:write`-gated server action; the switches render read-only
 * without the permission. Optimistic, reverting on failure (mirrors the Discovery
 * toggles).
 */
export function DashboardWidgetToggles({
  settings,
  canWrite,
}: {
  settings: DashboardWidgetSettings;
  canWrite: boolean;
}) {
  const [state, setState] = React.useState<DashboardWidgetSettings>(settings);
  const [pending, setPending] = React.useState<DashboardWidgetId | null>(null);

  React.useEffect(() => setState(settings), [settings]);

  function toggle(id: DashboardWidgetId, next: boolean) {
    const prev = state[id];
    setState((s) => ({ ...s, [id]: next }));
    setPending(id);
    void (async () => {
      const res = await setDashboardWidgetAction(id, next);
      if (res.ok) {
        toast.success(res.message);
      } else {
        toast.error(res.error);
        setState((s) => ({ ...s, [id]: prev }));
      }
      setPending(null);
    })();
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {ORDER.map((id) => {
        const meta = WIDGET_META[id];
        const Icon = meta.icon;
        return (
          <li
            key={id}
            className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
          >
            <div className="flex items-start gap-3">
              <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-semibold">{meta.label}</p>
                <p className="text-sm text-muted-foreground">{meta.hint}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {pending === id && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
              <Switch
                checked={state[id]}
                disabled={!canWrite || pending !== null}
                onCheckedChange={(next) => toggle(id, next)}
                aria-label={meta.label}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
