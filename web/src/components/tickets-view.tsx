"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TicketListItem } from "@/lib/data";

/**
 * `/tickets` shell (spec 33). Full master–detail UI lands in Task 5; this stub
 * proves the route and lists ticket numbers + subjects from the server payload.
 */
export function TicketsView({
  initialTickets,
  viewerEmail: _viewerEmail,
}: {
  initialTickets: TicketListItem[];
  viewerEmail: string;
}) {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
          <p className="text-muted-foreground text-sm">
            Service tickets linked to assets and alerts.
          </p>
        </div>
        <Button type="button" variant="default" disabled>
          <Plus className="size-4" />
          New Ticket
        </Button>
      </div>

      {initialTickets.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tickets yet.</p>
      ) : (
        <ul className="divide-border divide-y rounded-lg border">
          {initialTickets.map((t) => (
            <li key={t.id} className="flex gap-4 px-4 py-3 text-sm">
              <span className="text-muted-foreground w-24 shrink-0 font-mono">
                TKT-{t.number}
              </span>
              <span className="min-w-0 flex-1 truncate">{t.subject}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
