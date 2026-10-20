"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheck, Loader2, Ticket } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/app/(app)/notification-actions";
import {
  createTicketFromNotificationAction,
  lookupTicketIdsByNotificationIdsAction,
} from "@/app/(app)/ticket-actions";
import type { NotificationItem } from "@/lib/data";
import {
  NOTIFICATION_FALLBACK_ICON,
  NOTIFICATION_ICON,
  NOTIFICATION_SEVERITY_VAR,
  NOTIFICATION_TYPE_LABEL,
  timeAgo,
} from "@/lib/notification-ui";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 30;

type Filter = "all" | "unread";

/**
 * The full notification feed on `/notifications` (spec 19, AC-9). Hydrated from a
 * server-rendered first page, then drives All/Unread filtering, load-more
 * pagination, mark-one (on click-through), and mark-all against the REST + action
 * endpoints. Admin-only is enforced at the page and the APIs.
 */
export function NotificationsView({
  initialItems,
  initialNextBefore,
  initialUnread,
  initialTicketByNotificationId,
  isAdmin,
}: {
  initialItems: NotificationItem[];
  initialNextBefore: string | null;
  initialUnread: number;
  initialTicketByNotificationId: Record<string, string>;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [items, setItems] = React.useState<NotificationItem[]>(initialItems);
  const [nextBefore, setNextBefore] = React.useState<string | null>(
    initialNextBefore,
  );
  const [unread, setUnread] = React.useState(initialUnread);
  const [loading, setLoading] = React.useState(false);
  const [ticketByNotificationId, setTicketByNotificationId] = React.useState(
    initialTicketByNotificationId,
  );
  const [creatingFor, setCreatingFor] = React.useState<string | null>(null);

  React.useEffect(
    () => setTicketByNotificationId(initialTicketByNotificationId),
    [initialTicketByNotificationId],
  );

  const mergeTicketMap = React.useCallback(
    async (notificationIds: string[]) => {
      if (!isAdmin || notificationIds.length === 0) return;
      const res = await lookupTicketIdsByNotificationIdsAction(notificationIds);
      if (res.ok) {
        setTicketByNotificationId((prev) => ({ ...prev, ...res.map }));
      }
    },
    [isAdmin],
  );

  const fetchPage = React.useCallback(
    async (f: Filter, before?: string) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (f === "unread") params.set("unread", "1");
      if (before) params.set("before", before);
      const res = await fetch(`/api/notifications?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) return null;
      return (await res.json()) as {
        items: NotificationItem[];
        nextBefore: string | null;
        unread: number;
      };
    },
    [],
  );

  async function applyFilter(f: Filter) {
    setFilter(f);
    setLoading(true);
    const data = await fetchPage(f);
    setLoading(false);
    if (!data) return;
    setItems(data.items);
    setNextBefore(data.nextBefore);
    setUnread(data.unread);
    await mergeTicketMap(data.items.map((x) => x.id));
  }

  async function loadMore() {
    if (!nextBefore) return;
    setLoading(true);
    const data = await fetchPage(filter, nextBefore);
    setLoading(false);
    if (!data) return;
    setItems((prev) => [...prev, ...data.items]);
    setNextBefore(data.nextBefore);
    await mergeTicketMap(data.items.map((x) => x.id));
  }

  async function markAll() {
    setItems((prev) =>
      filter === "unread" ? [] : prev.map((x) => ({ ...x, read: true })),
    );
    setUnread(0);
    await markAllNotificationsReadAction();
  }

  async function openItem(item: NotificationItem) {
    if (!item.read) {
      setItems((prev) =>
        filter === "unread"
          ? prev.filter((x) => x.id !== item.id)
          : prev.map((x) => (x.id === item.id ? { ...x, read: true } : x)),
      );
      setUnread((u) => Math.max(0, u - 1));
      const res = await markNotificationReadAction(item.id);
      if (res.ok && typeof res.unread === "number") setUnread(res.unread);
    }
    router.push(item.href);
  }

  async function createTicket(notificationId: string) {
    setCreatingFor(notificationId);
    const res = await createTicketFromNotificationAction(notificationId);
    setCreatingFor(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(res.message);
    if (res.ticketId) {
      setTicketByNotificationId((prev) => ({
        ...prev,
        [notificationId]: res.ticketId!,
      }));
      router.push(`/tickets?id=${res.ticketId}`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border p-0.5">
          {(["all", "unread"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => applyFilter(f)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                filter === f
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f}
              {f === "unread" && unread > 0 ? ` (${unread})` : ""}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          onClick={markAll}
          disabled={unread === 0}
        >
          <CheckCheck className="size-4" /> Mark all read
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        {items.length === 0 ? (
          <p className="px-4 py-16 text-center text-sm text-muted-foreground">
            {filter === "unread"
              ? "No unread notifications."
              : "No notifications yet."}
          </p>
        ) : (
          items.map((item) => {
            const Icon = NOTIFICATION_ICON[item.type] ?? NOTIFICATION_FALLBACK_ICON;
            const ticketId = ticketByNotificationId[item.id];
            return (
              <div
                key={item.id}
                className={cn(
                  "flex items-stretch gap-2 border-b last:border-b-0",
                  !item.read && "bg-accent/25",
                )}
              >
                <button
                  type="button"
                  onClick={() => openItem(item)}
                  className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3.5 text-left hover:bg-accent/50"
                >
                  <span
                    aria-hidden
                    className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg"
                    style={{
                      backgroundColor: `color-mix(in oklch, ${NOTIFICATION_SEVERITY_VAR[item.severity]}, transparent 85%)`,
                      color: NOTIFICATION_SEVERITY_VAR[item.severity],
                    }}
                  >
                    <Icon className="size-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{item.title}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {NOTIFICATION_TYPE_LABEL[item.type]}
                      </span>
                      {!item.read && (
                        <span
                          aria-hidden
                          className="size-1.5 rounded-full bg-primary"
                        />
                      )}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {item.body}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground/70">
                      {timeAgo(item.createdAt)}
                    </span>
                  </span>
                </button>
                {isAdmin && (
                  <div className="flex shrink-0 items-center px-3 py-3.5">
                    {ticketId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        nativeButton={false}
                        render={
                          <Link href={`/tickets?id=${ticketId}`} />
                        }
                      >
                        <Ticket className="size-3.5" /> View ticket
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={creatingFor === item.id}
                        onClick={() => void createTicket(item.id)}
                      >
                        {creatingFor === item.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Ticket className="size-3.5" />
                        )}
                        Create ticket
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {nextBefore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
