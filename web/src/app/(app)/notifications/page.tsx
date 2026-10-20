import { Bell } from "lucide-react";

import { HeroHeader } from "@/components/hero-header";
import { NotificationsView } from "@/components/notifications-view";
import { getUnreadCount, listNotifications } from "@/db/notifications";
import { hasPermission, requireUser } from "@/lib/auth/session";

// The feed changes with every scan/sweep; always read fresh.
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();
  const isAdmin = hasPermission(user, "user:admin");

  const viewer = {
    userKey: user.id || user.email,
    email: user.email,
    isAdmin,
  };
  const [{ items, nextBefore }, unread] = await Promise.all([
    listNotifications(viewer, { limit: 30 }),
    getUnreadCount(viewer),
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
