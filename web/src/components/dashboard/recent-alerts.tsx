import Link from "next/link";

import { timeAgo } from "@/lib/notification-ui";

export interface AlertItem {
  id: string;
  colorVar: string; // dot color
  title: string;
  subtitle: string;
  at: string; // ISO
  href: string;
}

/**
 * The dashboard "Recent Alerts" list: a colored severity dot, a title + subtitle,
 * and a relative time, each row linking to its target. Fed by recent notifications
 * for admins (spec 19) or recent discovered devices for everyone else.
 */
export function RecentAlerts({
  items,
  emptyMessage,
}: {
  items: AlertItem[];
  emptyMessage: string;
}) {
  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {items.map((a) => (
        <li key={a.id} className="border-b last:border-b-0">
          <Link
            href={a.href}
            className="flex items-start gap-3 py-3 hover:opacity-80"
          >
            <span
              aria-hidden
              className="mt-1.5 size-2 shrink-0 rounded-full"
              style={{ backgroundColor: a.colorVar }}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {a.title}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {a.subtitle}
              </span>
            </span>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {timeAgo(a.at)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
