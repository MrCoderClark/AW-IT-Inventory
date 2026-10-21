export function ticketNotifyRecipients(
  ticket: {
    assigneeEmail?: string | null;
    requesterEmail?: string | null;
  },
  actorEmail: string,
  opts?: { includeRequester?: boolean },
): string[] {
  const actor = actorEmail.trim().toLowerCase();
  const out: string[] = [];
  const add = (email: string | null | undefined) => {
    const e = email?.trim();
    if (!e) return;
    if (e.toLowerCase() === actor) return;
    if (out.some((x) => x.toLowerCase() === e.toLowerCase())) return;
    out.push(e);
  };
  add(ticket.assigneeEmail);
  if (opts?.includeRequester) add(ticket.requesterEmail);
  return out;
}
