import { Lock } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";
import { TicketsView } from "@/components/tickets-view";
import { listTickets } from "@/db/tickets";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function TicketsPage({
  searchParams,
}: PageProps<"/tickets">) {
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

  const tickets = await listTickets();
  const { id: rawId } = await searchParams;
  const initialTicketId =
    typeof rawId === "string" && rawId.length > 0 ? rawId : null;

  return (
    <TicketsView
      initialTickets={tickets}
      viewerEmail={user.email}
      initialTicketId={initialTicketId}
    />
  );
}
