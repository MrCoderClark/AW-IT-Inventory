import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { PagePlaceholder } from "@/components/page-placeholder";
import { TicketWorkspace } from "@/components/ticket-workspace";
import { getTicket } from "@/db/tickets";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function TicketDetailPage({
  params,
}: PageProps<"/tickets/[id]">) {
  const user = await requireUser();
  if (!hasPermission(user, "user:admin")) {
    return (
      <PagePlaceholder
        title="Ticket"
        description="You don't have permission to manage tickets. Ask an administrator for the user:admin role."
        icon={Lock}
      />
    );
  }
  const { id } = await params;
  const ticket = await getTicket(id);
  if (!ticket) notFound();
  return <TicketWorkspace ticket={ticket} />;
}
