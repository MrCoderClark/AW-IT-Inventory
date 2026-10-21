"use client";

import { ticketKpiCounts } from "@/lib/ticket-ui";
import type { TicketListItem } from "@/lib/data";
import { cn } from "@/lib/utils";

export function TicketKpiStrip({ tickets }: { tickets: TicketListItem[] }) {
  const c = ticketKpiCounts(tickets);
  const cards = [
    { label: "Open", value: c.open, accent: "text-blue-600" },
    { label: "In Progress", value: c.inProgress, accent: "text-sky-600" },
    { label: "Waiting", value: c.waiting, accent: "text-amber-600" },
    { label: "Resolved", value: c.resolved, accent: "text-emerald-600" },
  ] as const;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-xl border bg-card px-4 py-3 shadow-sm"
        >
          <p className="text-muted-foreground text-xs font-medium">{card.label}</p>
          <p className={cn("mt-1 text-2xl font-semibold tracking-tight", card.accent)}>
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}
