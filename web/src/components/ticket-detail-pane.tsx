"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  addTicketCommentAction,
  updateTicketAction,
} from "@/app/(app)/ticket-actions";
import { fmtDateTime } from "@/components/detail-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  TicketCommentItem,
  TicketListItem,
  TicketPriority,
  TicketStatus,
} from "@/lib/data";
import {
  assigneeLabel,
  categoryLabel,
  ticketNumberLabel,
  ticketPriorityVariant,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  ticketStatusVariant,
} from "@/lib/ticket-ui";
import { cn } from "@/lib/utils";

const STATUSES: TicketStatus[] = ["open", "in_progress", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "medium", "high"];

export type TicketDetail = TicketListItem & { comments: TicketCommentItem[] };

export function TicketDetailPane({
  ticket,
  loading,
  onSaved,
}: {
  ticket: TicketDetail | null;
  loading?: boolean;
  onSaved?: () => void;
}) {
  const [status, setStatus] = React.useState<TicketStatus>("open");
  const [priority, setPriority] = React.useState<TicketPriority>("medium");
  const [assigneeEmail, setAssigneeEmail] = React.useState("");
  const [commentBody, setCommentBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [commentPending, setCommentPending] = React.useState(false);

  React.useEffect(() => {
    if (!ticket) return;
    setStatus(ticket.status);
    setPriority(ticket.priority);
    setAssigneeEmail(ticket.assigneeEmail ?? "");
    setCommentBody("");
  }, [ticket]);

  if (!ticket && !loading) {
    return (
      <aside className="hidden w-full max-w-md shrink-0 rounded-xl border bg-card p-6 text-sm text-muted-foreground lg:block">
        Select a ticket to view details, update status, and add comments.
      </aside>
    );
  }

  if (loading && !ticket) {
    return (
      <aside className="flex w-full max-w-md shrink-0 items-center justify-center rounded-xl border bg-card p-8 lg:block">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </aside>
    );
  }

  if (!ticket) return null;

  const dirty =
    status !== ticket.status ||
    priority !== ticket.priority ||
    assigneeEmail.trim() !== (ticket.assigneeEmail ?? "");

  async function saveFields() {
    if (!ticket) return;
    setSaving(true);
    const assigneeRaw = assigneeEmail.trim();
    const res = await updateTicketAction(ticket.id, {
      status,
      priority,
      assigneeEmail: assigneeRaw ? assigneeRaw : null,
    });
    setSaving(false);
    if (res.ok) {
      toast.success(res.message);
      onSaved?.();
    } else {
      toast.error(res.error);
    }
  }

  async function submitComment() {
    if (!ticket) return;
    const body = commentBody.trim();
    if (!body) return;
    setCommentPending(true);
    const res = await addTicketCommentAction(ticket.id, body);
    setCommentPending(false);
    if (res.ok) {
      toast.success(res.message);
      setCommentBody("");
      onSaved?.();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <aside className="flex w-full max-w-md shrink-0 flex-col rounded-xl border bg-card lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto">
      <div className="border-b p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Ticket detail</h2>
          <span className="font-mono text-xs text-muted-foreground">
            {ticketNumberLabel(ticket.number)}
          </span>
          <Badge variant={ticketPriorityVariant(ticket.priority)}>
            {TICKET_PRIORITY_LABEL[ticket.priority]}
          </Badge>
        </div>
        <p className="text-sm font-medium leading-snug">{ticket.subject}</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-b p-4 text-xs">
        <Meta label="Asset">
          {ticket.assetTag ? (
            <Link
              href={`/assets/${ticket.assetTag}`}
              className="text-primary hover:underline"
            >
              {ticket.assetTag}
            </Link>
          ) : (
            "—"
          )}
        </Meta>
        <Meta label="Category">{categoryLabel(ticket.category)}</Meta>
        <Meta label="Assignee">{assigneeLabel(ticket.assigneeEmail)}</Meta>
        <Meta label="Created">{fmtDateTime(ticket.createdAt)}</Meta>
        <Meta label="Created by">{ticket.createdBy}</Meta>
        <Meta label="Status">
          <Badge variant={ticketStatusVariant(ticket.status)}>
            {TICKET_STATUS_LABEL[ticket.status]}
          </Badge>
        </Meta>
      </dl>

      {ticket.description ? (
        <div className="border-b p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Description
          </h3>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {ticket.description}
          </p>
        </div>
      ) : null}

      <div className="space-y-3 border-b p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Update
        </h3>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-xs">
            Status
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as TicketStatus)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {TICKET_STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-xs">
            Priority
            <Select
              value={priority}
              onValueChange={(v) => setPriority(v as TicketPriority)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {TICKET_PRIORITY_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-xs">
            Assignee email
            <Input
              type="email"
              value={assigneeEmail}
              onChange={(e) => setAssigneeEmail(e.target.value)}
              placeholder="Unassigned"
            />
          </label>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void saveFields()}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save changes
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Timeline
        </h3>
        <ul className="flex flex-col gap-3">
          {ticket.comments.map((c) => (
            <li key={c.id} className="flex gap-2 text-sm">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  c.kind === "system" ? "bg-muted-foreground/50" : "bg-primary",
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p
                  className={
                    c.kind === "system"
                      ? "text-muted-foreground italic"
                      : undefined
                  }
                >
                  {c.body}
                </p>
                <p className="text-muted-foreground text-xs">
                  {c.kind === "user" ? `${c.authorEmail} · ` : ""}
                  {fmtDateTime(c.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-auto grid gap-2 pt-2">
          <label className="grid gap-2 text-xs">
            Add comment
            <Textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              rows={3}
              placeholder="Note for the team…"
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={commentPending || !commentBody.trim()}
            onClick={() => void submitComment()}
          >
            {commentPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Post comment
          </Button>
        </div>
      </div>
    </aside>
  );
}

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium">{children}</dd>
    </>
  );
}
