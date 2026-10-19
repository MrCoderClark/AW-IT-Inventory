"use client";

import * as React from "react";
import { CalendarDays } from "lucide-react";

/**
 * The dashboard's date + time, top-right of the header. Client-only (it reads the
 * live clock), so it renders nothing on the server and fills in on mount to avoid
 * a hydration mismatch; it then ticks once a minute.
 */
export function LiveClock() {
  const [now, setNow] = React.useState<Date | null>(null);

  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const dateLabel = now
    ? now.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "\u00a0";
  const timeLabel = now
    ? now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "\u00a0";

  return (
    <time
      dateTime={now?.toISOString()}
      className="flex h-8 shrink-0 items-center gap-2 text-sm text-muted-foreground"
    >
      <CalendarDays className="size-4 shrink-0" aria-hidden />
      <span className="whitespace-nowrap leading-none">
        <span className="font-medium text-foreground">{dateLabel}</span>
        <span className="mx-2 text-foreground/25" aria-hidden>
          ·
        </span>
        <span className="tabular-nums">{timeLabel}</span>
      </span>
    </time>
  );
}
