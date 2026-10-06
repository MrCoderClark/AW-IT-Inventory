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

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <CalendarDays className="size-4 shrink-0" />
      <span className="text-right leading-tight">
        {now ? (
          <>
            <span className="block font-medium text-foreground">
              {now.toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            <span className="block text-xs">
              {now.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </>
        ) : (
          // Reserve height so the header doesn't jump when the clock mounts.
          <span className="block h-8" />
        )}
      </span>
    </div>
  );
}
