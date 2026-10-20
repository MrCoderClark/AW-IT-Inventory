"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  addTicketCommentAction,
  updateTicketAction,
} from "@/app/(app)/ticket-actions";
import { fmtDateTime } from "@/components/detail-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
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

const STATUSES: TicketStatus[] = ["open", "in_progress", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "medium", "high"];

export type TicketDetail = TicketListItem & { comments: TicketCommentItem[] };

function emailInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  const compact = local.replace(/[^a-zA-Z0-9]/g, "");
  return (compact.slice(0, 2) || "?").toUpperCase();
}

export function TicketWorkspace({ ticket }: { ticket: TicketDetail }) {
  const router = useRouter();
  const noteRef = React.useRef<HTMLTextAreaElement>(null);
  const assigneeRef = React.useRef<HTMLInputElement>(null);
  const focusNoteAfterTab = React.useRef(false);

  const [tab, setTab] = React.useState("conversation");
  const [status, setStatus] = React.useState<TicketStatus>(ticket.status);
  const [priority, setPriority] = React.useState<TicketPriority>(ticket.priority);
  const [assigneeEmail, setAssigneeEmail] = React.useState(
    ticket.assigneeEmail ?? "",
  );
  const [commentBody, setCommentBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [commentPending, setCommentPending] = React.useState(false);

  React.useEffect(() => {
    setStatus(ticket.status);
    setPriority(ticket.priority);
    setAssigneeEmail(ticket.assigneeEmail ?? "");
  }, [ticket.id]);

  React.useEffect(() => {
    setCommentBody("");
  }, [ticket.id]);

  React.useEffect(() => {
    if (!focusNoteAfterTab.current || tab !== "conversation") return;
    focusNoteAfterTab.current = false;
    noteRef.current?.focus();
  }, [tab]);

  const dirty =
    status !== ticket.status ||
    priority !== ticket.priority ||
    assigneeEmail.trim() !== (ticket.assigneeEmail ?? "");

  const userComments = ticket.comments.filter((c) => c.kind === "user");
  const systemComments = ticket.comments.filter((c) => c.kind === "system");

  function focusNote() {
    if (tab === "conversation") {
      noteRef.current?.focus();
      return;
    }
    focusNoteAfterTab.current = true;
    setTab("conversation");
  }

  async function saveFields() {
    if (!dirty || saving) return;
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
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function submitComment() {
    const body = commentBody.trim();
    if (!body || commentPending) return;
    setCommentPending(true);
    const res = await addTicketCommentAction(ticket.id, body);
    setCommentPending(false);
    if (res.ok) {
      toast.success(res.message);
      setCommentBody("");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <Link
        href="/tickets"
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        ← Back to Tickets
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={ticketPriorityVariant(ticket.priority)}>
            {TICKET_PRIORITY_LABEL[ticket.priority]}
          </Badge>
          <span className="text-muted-foreground font-mono text-sm">
            #{ticketNumberLabel(ticket.number)}
          </span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{ticket.subject}</h1>
        {ticket.description ? (
          <p className="text-muted-foreground max-w-3xl whitespace-pre-wrap text-sm">
            {ticket.description}
          </p>
        ) : null}
        <p className="text-muted-foreground text-sm">
          Created {fmtDateTime(ticket.createdAt)} · Updated{" "}
          {fmtDateTime(ticket.updatedAt)}
        </p>
      </header>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-end">
        <Field label="Status">
          <Select
            value={status}
            onValueChange={(v) => {
              if (v) setStatus(v as TicketStatus);
            }}
          >
            <SelectTrigger className="w-full sm:w-[160px]">
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
        </Field>
        <Field label="Priority">
          <Select
            value={priority}
            onValueChange={(v) => {
              if (v) setPriority(v as TicketPriority);
            }}
          >
            <SelectTrigger className="w-full sm:w-[140px]">
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
        </Field>
        <Field label="Assignee">
          <Input
            ref={assigneeRef}
            type="email"
            aria-label="Assignee email"
            value={assigneeEmail}
            onChange={(e) => setAssigneeEmail(e.target.value)}
            placeholder="Unassigned"
            className="w-full sm:w-56"
          />
        </Field>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button type="button" variant="outline" onClick={focusNote}>
            Add note
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => assigneeRef.current?.focus()}
          >
            Assign
          </Button>
          <Button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void saveFields()}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Update
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
            <TabsList>
              <TabsTab value="conversation">Conversation</TabsTab>
              <TabsTab value="activity">Activity</TabsTab>
              <TabsTab value="details">Details</TabsTab>
              <TabsTab value="assets">Assets</TabsTab>
            </TabsList>

            <TabsPanel value="conversation" className="flex flex-col gap-4">
              {userComments.length === 0 ? (
                <p className="text-muted-foreground text-sm">No notes yet.</p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {userComments.map((c) => (
                    <li key={c.id} className="flex gap-3">
                      <span
                        className="bg-muted text-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                        aria-hidden
                      >
                        {emailInitials(c.authorEmail)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{c.authorEmail}</p>
                        <p className="text-muted-foreground text-xs">
                          {fmtDateTime(c.createdAt)}
                        </p>
                        <p className="mt-1 text-sm whitespace-pre-wrap">{c.body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid gap-2">
                <Textarea
                  ref={noteRef}
                  aria-label="Note"
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  rows={3}
                  placeholder="Note for the team…"
                />
                <div>
                  <Button
                    type="button"
                    disabled={commentPending || !commentBody.trim()}
                    onClick={() => void submitComment()}
                  >
                    {commentPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    Send
                  </Button>
                </div>
              </div>
            </TabsPanel>

            <TabsPanel value="activity">
              {systemComments.length === 0 ? (
                <p className="text-muted-foreground text-sm">No activity yet.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {systemComments.map((c) => (
                    <li key={c.id} className="text-sm">
                      <p className="text-muted-foreground italic">{c.body}</p>
                      <p className="text-muted-foreground text-xs">
                        {fmtDateTime(c.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </TabsPanel>

            <TabsPanel value="details">
              <dl className="grid max-w-lg gap-3 text-sm">
                <DetailRow label="Category">
                  {categoryLabel(ticket.category)}
                </DetailRow>
                <DetailRow label="Created by">{ticket.createdBy}</DetailRow>
                <DetailRow label="Source">
                  {ticket.sourceNotificationId ? (
                    <span>
                      From alert{" "}
                      <Link
                        href="/notifications"
                        className="text-primary font-mono text-xs hover:underline"
                      >
                        {ticket.sourceNotificationId}
                      </Link>
                    </span>
                  ) : (
                    "—"
                  )}
                </DetailRow>
              </dl>
            </TabsPanel>

            <TabsPanel value="assets">
              <AssetCard ticket={ticket} />
            </TabsPanel>
          </Tabs>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-80">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Ticket details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-2 text-sm">
                <DetailRow label="ID">{ticketNumberLabel(ticket.number)}</DetailRow>
                <DetailRow label="Status">
                  <Badge variant={ticketStatusVariant(ticket.status)}>
                    {TICKET_STATUS_LABEL[ticket.status]}
                  </Badge>
                </DetailRow>
                <DetailRow label="Priority">
                  <Badge variant={ticketPriorityVariant(ticket.priority)}>
                    {TICKET_PRIORITY_LABEL[ticket.priority]}
                  </Badge>
                </DetailRow>
                <DetailRow label="Category">
                  {categoryLabel(ticket.category)}
                </DetailRow>
                <DetailRow label="Requester">{ticket.createdBy}</DetailRow>
                <DetailRow label="Assignee">
                  {assigneeLabel(ticket.assigneeEmail)}
                </DetailRow>
                <DetailRow label="Location">
                  {ticket.locationLabel ?? "—"}
                </DetailRow>
                <DetailRow label="Created">
                  {fmtDateTime(ticket.createdAt)}
                </DetailRow>
                <DetailRow label="Updated">
                  {fmtDateTime(ticket.updatedAt)}
                </DetailRow>
              </dl>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle>Related asset</CardTitle>
            </CardHeader>
            <CardContent>
              <AssetCard ticket={ticket} compact />
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function AssetCard({
  ticket,
  compact = false,
}: {
  ticket: TicketDetail;
  compact?: boolean;
}) {
  if (!ticket.assetTag) {
    return (
      <p className="text-muted-foreground text-sm">No linked asset.</p>
    );
  }

  return (
    <div className={compact ? undefined : "rounded-xl border bg-card p-4"}>
      {ticket.assetName ? (
        <p className="text-sm font-medium">{ticket.assetName}</p>
      ) : null}
      <Link
        href={`/assets/${ticket.assetTag}`}
        className="text-primary font-mono text-sm hover:underline"
      >
        {ticket.assetTag}
      </Link>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}
