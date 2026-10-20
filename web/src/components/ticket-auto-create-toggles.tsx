"use client";

import * as React from "react";
import { Loader2, Ticket } from "lucide-react";
import { toast } from "sonner";

import { setTicketAutoCreateTypeAction } from "@/app/(app)/ticket-actions";
import { Switch } from "@/components/ui/switch";
import type { NotificationType } from "@/lib/data";
import {
  NOTIFICATION_ICON,
  NOTIFICATION_TYPE_LABEL,
} from "@/lib/notification-ui";

/**
 * Per notification-type switches on Admin for spec 33 auto-create. Off (or no row)
 * means no automatic ticket; admins can still create manually from /notifications.
 */
export function TicketAutoCreateToggles({
  types,
  canWrite,
}: {
  types: { type: NotificationType; enabled: boolean }[];
  canWrite: boolean;
}) {
  const [state, setState] = React.useState(types);
  const [pending, setPending] = React.useState<NotificationType | null>(null);

  React.useEffect(() => setState(types), [types]);

  function toggle(type: NotificationType, next: boolean) {
    const prev = state.find((t) => t.type === type)?.enabled ?? false;
    setState((rows) =>
      rows.map((r) => (r.type === type ? { ...r, enabled: next } : r)),
    );
    setPending(type);
    void (async () => {
      const res = await setTicketAutoCreateTypeAction(type, next);
      if (res.ok) {
        toast.success(res.message);
      } else {
        toast.error(res.error);
        setState((rows) =>
          rows.map((r) => (r.type === type ? { ...r, enabled: prev } : r)),
        );
      }
      setPending(null);
    })();
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {state.map(({ type, enabled }) => {
        const Icon = NOTIFICATION_ICON[type] ?? Ticket;
        return (
          <li
            key={type}
            className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
          >
            <div className="flex items-start gap-3">
              <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-semibold">
                  {NOTIFICATION_TYPE_LABEL[type]}
                </p>
                <p className="text-sm text-muted-foreground">
                  Automatically open a ticket when this notification is created.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {pending === type && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
              <Switch
                checked={enabled}
                disabled={!canWrite || pending !== null}
                onCheckedChange={(next) => toggle(type, next)}
                aria-label={`Auto-create tickets for ${NOTIFICATION_TYPE_LABEL[type]}`}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
