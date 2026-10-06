"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell, CheckCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHasPermission } from "@/components/user-provider";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/app/(app)/notification-actions";
import type { NotificationItem } from "@/lib/data";
import {
  NOTIFICATION_FALLBACK_ICON,
  NOTIFICATION_ICON,
  NOTIFICATION_SEVERITY_VAR,
  timeAgo,
} from "@/lib/notification-ui";
import { cn } from "@/lib/utils";

const PANEL_LIMIT = 10;

/**
 * The notification bell (spec 19). Renders only for `user:admin` (AC-6). Shows the
 * unread count and a panel of the most recent items; subscribes to the SSE stream
 * for a live count, and re-syncs via REST on mount / each panel open so a missed
 * stream event self-heals (AC-7). Clicking an item marks it read and opens its
 * target; "Mark all read" clears the count (AC-8).
 */
export function NotificationBell() {
  const isAdmin = useHasPermission("user:admin");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<NotificationItem[]>([]);
  const [unread, setUnread] = React.useState(0);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/notifications?limit=${PANEL_LIMIT}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        items: NotificationItem[];
        unread: number;
      };
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      // Offline or transient — the SSE 'count' event will resync.
    }
  }, []);

  // Initial sync + live stream. Only an admin ever opens the stream.
  React.useEffect(() => {
    if (!isAdmin) return;
    load();
    const es = new EventSource("/api/notifications/stream");
    es.addEventListener("count", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { unread: number };
        setUnread(d.unread ?? 0);
      } catch {
        /* ignore malformed frame */
      }
    });
    es.addEventListener("notification", (e) => {
      try {
        const n = JSON.parse((e as MessageEvent).data) as NotificationItem;
        setItems((prev) =>
          prev.some((p) => p.id === n.id)
            ? prev
            : [{ ...n, meta: null, read: false }, ...prev].slice(0, PANEL_LIMIT),
        );
        setUnread((u) => u + 1);
      } catch {
        /* ignore malformed frame */
      }
    });
    return () => es.close();
  }, [isAdmin, load]);

  if (!isAdmin) return null;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) load();
  };

  async function openItem(item: NotificationItem) {
    setOpen(false);
    if (!item.read) {
      setItems((p) =>
        p.map((x) => (x.id === item.id ? { ...x, read: true } : x)),
      );
      setUnread((u) => Math.max(0, u - 1));
      const res = await markNotificationReadAction(item.id);
      if (res.ok && typeof res.unread === "number") setUnread(res.unread);
    }
    router.push(item.href);
  }

  async function markAll() {
    setItems((p) => p.map((x) => ({ ...x, read: true })));
    setUnread(0);
    await markAllNotificationsReadAction();
  }

  const badge = unread > 9 ? "9+" : String(unread);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label={
              unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
            }
            className="relative"
          />
        }
      >
        <Bell className="size-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {badge}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <button
              type="button"
              onClick={markAll}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </button>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              You&rsquo;re all caught up.
            </p>
          ) : (
            items.map((item) => {
              const Icon = NOTIFICATION_ICON[item.type] ?? NOTIFICATION_FALLBACK_ICON;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openItem(item)}
                  className={cn(
                    "flex w-full items-start gap-3 border-b px-3 py-3 text-left last:border-b-0 hover:bg-accent/60",
                    !item.read && "bg-accent/30",
                  )}
                >
                  <span
                    aria-hidden
                    className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg"
                    style={{
                      backgroundColor: `color-mix(in oklch, ${NOTIFICATION_SEVERITY_VAR[item.severity]}, transparent 85%)`,
                      color: NOTIFICATION_SEVERITY_VAR[item.severity],
                    }}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {item.title}
                      </span>
                      {!item.read && (
                        <span
                          aria-hidden
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                        />
                      )}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {item.body}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground/70">
                      {timeAgo(item.createdAt)}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="border-t px-3 py-2">
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block rounded-md py-1.5 text-center text-sm font-medium text-primary hover:underline"
          >
            View all
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
