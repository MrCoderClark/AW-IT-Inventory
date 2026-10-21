import { Lock } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";
import { TicketsView } from "@/components/tickets-view";
import { getLinkAssets } from "@/db/queries";
import { listTickets } from "@/db/tickets";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function TicketsPage() {
  const user = await requireUser();

  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Tickets"
        description="You don't have permission to manage tickets. Ask an administrator for the user:admin role."
        icon={Lock}
      />
    );
  }

  const [tickets, linkAssets] = await Promise.all([
    listTickets(),
    getLinkAssets(),
  ]);

  return (
    <TicketsView
      initialTickets={tickets}
      linkAssets={linkAssets}
      viewerEmail={user.email}
    />
  );
}
