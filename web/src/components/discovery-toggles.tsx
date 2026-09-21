"use client";

import * as React from "react";
import { Loader2, Monitor, Printer } from "lucide-react";
import { toast } from "sonner";

import { setDiscoveryToggleAction } from "@/app/(app)/discovery-actions";
import { Switch } from "@/components/ui/switch";
import type { DiscoverySettings, DiscoveryType } from "@/db/discovery";

const TYPE_META: Record<
  DiscoveryType,
  { label: string; hint: string; icon: React.ComponentType<{ className?: string }> }
> = {
  computer: {
    label: "Computers",
    hint: "Discover and collect Windows machines over WinRM.",
    icon: Monitor,
  },
  printer: {
    label: "Printers",
    hint: "Discover printers over SNMP and run scheduled reachability checks.",
    icon: Printer,
  },
};

const ORDER: DiscoveryType[] = ["computer", "printer"];

/**
 * The Discovery switches on the Admin page (spec 13, AC-1). Each switch flips one
 * device type on or off through the `scan:write`-gated server action. Editable
 * only when `canWrite` is true; otherwise the switches render read-only (AC-7).
 * State is optimistic and reverts if the action fails.
 */
export function DiscoveryToggles({
  settings,
  canWrite,
}: {
  settings: DiscoverySettings;
  canWrite: boolean;
}) {
  const [state, setState] = React.useState<DiscoverySettings>(settings);
  const [pending, setPending] = React.useState<DiscoveryType | null>(null);

  // Keep local state in sync when the server sends a fresh snapshot.
  React.useEffect(() => setState(settings), [settings]);

  function toggle(type: DiscoveryType, next: boolean) {
    const prev = state[type];
    setState((s) => ({ ...s, [type]: next }));
    setPending(type);
    void (async () => {
      const res = await setDiscoveryToggleAction(type, next);
      if (res.ok) {
        toast.success(res.message);
      } else {
        toast.error(res.error);
        setState((s) => ({ ...s, [type]: prev })); // revert on failure
      }
      setPending(null);
    })();
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {ORDER.map((type) => {
        const meta = TYPE_META[type];
        const Icon = meta.icon;
        return (
          <li
            key={type}
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
              {pending === type && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
              <Switch
                checked={state[type]}
                disabled={!canWrite || pending !== null}
                onCheckedChange={(next) => toggle(type, next)}
                aria-label={`Automatic ${meta.label} discovery`}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
