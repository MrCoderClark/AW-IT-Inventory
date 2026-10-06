import { Bell, Lock } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { NotificationsView } from "@/components/notifications-view";
import { getUnreadCount, listNotifications } from "@/db/notifications";
import { hasPermission, requireUser } from "@/lib/auth/session";

// The feed changes with every scan/sweep; always read fresh.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  // Notifications are admin-only (spec 19, AC-6).
  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Notifications"
        description="Notifications are for administrators. Ask an admin for the user:admin role."
        icon={Lock}
      />
    );
  }

  const userKey = user.id || user.email;
  const [{ items, nextBefore }, unread] = await Promise.all([
    listNotifications(userKey, { limit: 30 }),
    getUnreadCount(userKey),
  ]);

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <HeroHeader
        title="Notifications"
        subtitle="Printer outages, scan failures, new devices and warranty alerts across the fleet."
        icon={<Bell />}
      />
      <NotificationsView
        initialItems={items}
        initialNextBefore={nextBefore}
        initialUnread={unread}
      />
    </div>
  );
}
