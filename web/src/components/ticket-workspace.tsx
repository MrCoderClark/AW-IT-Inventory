"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Folder,
  Hash,
  Laptop,
  Loader2,
  MapPin,
  Paperclip,
  Tag,
  User,
} from "lucide-react";
import { toast } from "sonner";

import {
  addTicketCommentAction,
  updateTicketAction,
} from "@/app/(app)/ticket-actions";
import { fmtDateTime } from "@/components/detail-ui";
import { TicketAssetPicker } from "@/components/ticket-asset-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import type {
  LinkAsset,
  TicketCommentItem,
  TicketListItem,
  TicketPriority,
  TicketStatus,
} from "@/lib/data";
import {
  assigneeLabel,
  categoryLabel,
  isTicketCategory,
  requesterEmailOf,
  requesterLabel,
  ticketNumberLabel,
  ticketPriorityVariant,
  TICKET_CATEGORIES,
  type TicketCategory,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  ticketStatusVariant,
} from "@/lib/ticket-ui";
import { cn } from "@/lib/utils";

function normalizeCategory(value: string): TicketCategory {
  const trimmed = value.trim();
  return isTicketCategory(trimmed) ? trimmed : "General";
}

const STATUSES: TicketStatus[] = [
  "open",
  "in_progress",
  "waiting_on_user",
  "resolved",
  "closed",
];
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

function displayName(email: string): string {
  return assigneeLabel(email);
}

function authorRole(
  email: string,
  ticket: TicketDetail,
): string {
  const requester = requesterEmailOf(ticket).toLowerCase();
  if (email.toLowerCase() === requester) return "Requester";
  if (
    ticket.assigneeEmail &&
    email.toLowerCase() === ticket.assigneeEmail.toLowerCase()
  ) {
    return "Assignee";
  }
  return "IT Support";
}

function priorityBannerLabel(priority: TicketPriority): string {
  return `${TICKET_PRIORITY_LABEL[priority]} Priority`;
}

export function TicketWorkspace({
  ticket,
  linkAssets = [],
}: {
  ticket: TicketDetail;
  linkAssets?: LinkAsset[];
}) {
  const router = useRouter();
  const noteRef = React.useRef<HTMLInputElement>(null);
  const assigneeRef = React.useRef<HTMLInputElement>(null);
  const focusNoteAfterTab = React.useRef(false);

  const [tab, setTab] = React.useState("conversation");
  const [status, setStatus] = React.useState<TicketStatus>(ticket.status);
  const [priority, setPriority] = React.useState<TicketPriority>(ticket.priority);
  const [category, setCategory] = React.useState<TicketCategory>(() =>
    normalizeCategory(ticket.category),
  );
  const [assetId, setAssetId] = React.useState<string | null>(ticket.assetId);
  const [requesterEmail, setRequesterEmail] = React.useState(
    requesterEmailOf(ticket),
  );
  const [assigneeEmail, setAssigneeEmail] = React.useState(
    ticket.assigneeEmail ?? "",
  );
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = React.useState(false);
  const [commentBody, setCommentBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [commentPending, setCommentPending] = React.useState(false);

  React.useEffect(() => {
    setStatus(ticket.status);
    setPriority(ticket.priority);
    setCategory(normalizeCategory(ticket.category));
    setAssetId(ticket.assetId);
    setRequesterEmail(requesterEmailOf(ticket));
    setAssigneeEmail(ticket.assigneeEmail ?? "");
    setAssignOpen(false);
    setAssetPickerOpen(false);
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
    category !== normalizeCategory(ticket.category) ||
    assetId !== ticket.assetId ||
    requesterEmail.trim() !== requesterEmailOf(ticket) ||
    assigneeEmail.trim() !== (ticket.assigneeEmail ?? "");

  function applyAssetId(nextId: string | null) {
    setAssetId(nextId);
    if (!nextId) return;
    const owner = linkAssets.find((a) => a.id === nextId)?.ownerEmail;
    if (owner) setRequesterEmail(owner);
  }

  const userComments = ticket.comments.filter((c) => c.kind === "user");
  const systemComments = ticket.comments.filter((c) => c.kind === "system");

  const selectedLinkAsset = assetId
    ? linkAssets.find((a) => a.id === assetId) ?? null
    : null;
  const displayAssetTag =
    selectedLinkAsset?.tag ??
    (assetId === ticket.assetId ? ticket.assetTag : null);
  const displayAssetName =
    selectedLinkAsset?.name ??
    (assetId === ticket.assetId ? ticket.assetName : null);

  function focusNote() {
    if (tab === "conversation") {
      noteRef.current?.focus();
      return;
    }
    focusNoteAfterTab.current = true;
    setTab("conversation");
  }

  function openAssign() {
    setAssignOpen(true);
    queueMicrotask(() => assigneeRef.current?.focus());
  }

  async function saveFields() {
    if (!dirty || saving) return;
    setSaving(true);
    const assigneeRaw = assigneeEmail.trim();
    const requesterRaw = requesterEmail.trim();
    const res = await updateTicketAction(ticket.id, {
      status,
      priority,
      category,
      assigneeEmail: assigneeRaw ? assigneeRaw : null,
      requesterEmail: requesterRaw ? requesterRaw : null,
      assetId,
    });
    setSaving(false);
    if (res.ok) {
      toast.success(res.message);
      setAssignOpen(false);
      setAssetPickerOpen(false);
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
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      <Link
        href="/tickets"
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        ← Back to Tickets
      </Link>

      {/* Header — mock: priority pill + #id, title, description; actions + status right */}
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                priority === "high" &&
                  "bg-red-600 text-white dark:bg-red-700",
                priority === "medium" &&
                  "bg-orange-500 text-white dark:bg-orange-600",
                priority === "low" &&
                  "bg-slate-500 text-white dark:bg-slate-600",
              )}
            >
              {priorityBannerLabel(priority)}
            </span>
            <span className="text-muted-foreground font-mono text-sm">
              #{ticketNumberLabel(ticket.number)}
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {ticket.subject}
          </h1>
          {ticket.description ? (
            <p className="text-muted-foreground max-w-2xl whitespace-pre-wrap text-sm">
              {ticket.description}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-3 sm:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void saveFields()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Update
            </Button>
            <Button type="button" variant="outline" onClick={focusNote}>
              Add Note
            </Button>
            <Button type="button" variant="outline" onClick={openAssign}>
              Assign
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button type="button" variant="outline" />}
              >
                More
                <ChevronDown className="size-4 opacity-70" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                {PRIORITIES.map((p) => (
                  <DropdownMenuItem
                    key={p}
                    onClick={() => setPriority(p)}
                  >
                    Priority: {TICKET_PRIORITY_LABEL[p]}
                    {priority === p ? " ✓" : ""}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Select
              value={status}
              onValueChange={(v) => {
                if (v) setStatus(v as TicketStatus);
              }}
            >
              <SelectTrigger
                aria-label="Status"
                className="bg-primary text-primary-foreground border-primary hover:bg-primary/90 w-auto min-w-[7.5rem] gap-1 font-medium [&_svg]:text-primary-foreground"
              >
                <SelectValue>
                  {TICKET_STATUS_LABEL[status]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {TICKET_STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="text-muted-foreground space-y-0.5 text-right text-xs">
            <p>Created {fmtDateTime(ticket.createdAt)}</p>
            <p>Last Updated {fmtDateTime(ticket.updatedAt)}</p>
          </div>
        </div>
      </header>

      {assignOpen ? (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
          <label className="grid min-w-[16rem] flex-1 gap-1 text-xs">
            <span className="text-muted-foreground">Assignee email</span>
            <Input
              ref={assigneeRef}
              type="email"
              aria-label="Assignee email"
              value={assigneeEmail}
              onChange={(e) => setAssigneeEmail(e.target.value)}
              placeholder="Unassigned"
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAssignOpen(false)}
          >
            Hide
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
            <TabsList>
              <TabsTab value="conversation">Conversation</TabsTab>
              <TabsTab value="details">Details</TabsTab>
              <TabsTab value="assets">Assets</TabsTab>
              <TabsTab value="related">Related Tickets</TabsTab>
              <TabsTab value="activity">Activity</TabsTab>
            </TabsList>

            <TabsPanel value="conversation" className="flex flex-col gap-5 pt-2">
              {userComments.length === 0 ? (
                <p className="text-muted-foreground text-sm">No messages yet.</p>
              ) : (
                <ul className="flex flex-col gap-5">
                  {userComments.map((c) => (
                    <li key={c.id} className="flex gap-3">
                      <span
                        className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                        aria-hidden
                      >
                        {emailInitials(c.authorEmail)}
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <p className="text-sm font-semibold">
                            {displayName(c.authorEmail)}{" "}
                            <span className="text-muted-foreground font-normal">
                              ({authorRole(c.authorEmail, ticket)})
                            </span>
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {fmtDateTime(c.createdAt)}
                          </p>
                        </div>
                        <div className="bg-muted/40 rounded-lg border px-3 py-2.5 text-sm whitespace-pre-wrap">
                          {c.body}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex items-center gap-2 rounded-xl border bg-card px-2 py-1.5 shadow-sm">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground shrink-0"
                  disabled
                  aria-label="Attach file (coming soon)"
                  title="Attachments coming soon"
                >
                  <Paperclip className="size-4" />
                </Button>
                <Input
                  ref={noteRef}
                  aria-label="Note"
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  placeholder="Type a message…"
                  className="border-0 bg-transparent shadow-none focus-visible:ring-0"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submitComment();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  disabled={commentPending || !commentBody.trim()}
                  onClick={() => void submitComment()}
                >
                  {commentPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Send
                </Button>
              </div>
            </TabsPanel>

            <TabsPanel value="details" className="flex flex-col gap-4 pt-2">
              <label className="grid max-w-lg gap-1.5 text-sm">
                Category
                <Select
                  value={category}
                  onValueChange={(v) => {
                    if (v && isTicketCategory(v)) setCategory(v);
                  }}
                >
                  <SelectTrigger aria-label="Category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TICKET_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid max-w-lg gap-1.5 text-sm">
                Requester email
                <Input
                  aria-label="Requester email"
                  type="email"
                  value={requesterEmail}
                  onChange={(e) => setRequesterEmail(e.target.value)}
                  placeholder="Device owner / end user"
                />
              </label>
              <dl className="grid max-w-lg gap-3 text-sm">
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
              <p className="text-muted-foreground text-xs">
                Click Update to save category and other pending changes.
              </p>
            </TabsPanel>

            <TabsPanel value="assets" className="flex flex-col gap-3 pt-2">
              <AssetLinkEditor
                tag={displayAssetTag}
                name={displayAssetName}
                pickerOpen={assetPickerOpen}
                onTogglePicker={() => setAssetPickerOpen((o) => !o)}
                onUnlink={() => {
                  applyAssetId(null);
                  setAssetPickerOpen(false);
                }}
                assets={linkAssets}
                assetId={assetId}
                onPick={(id) => {
                  applyAssetId(id);
                  if (id) setAssetPickerOpen(false);
                }}
              />
            </TabsPanel>

            <TabsPanel value="related" className="pt-2">
              <p className="text-muted-foreground text-sm">
                Related tickets are coming soon.
              </p>
            </TabsPanel>

            <TabsPanel value="activity" className="pt-2">
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
          </Tabs>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-80">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Ticket details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm">
                <MetaRow icon={Hash} label="ID">
                  #{ticketNumberLabel(ticket.number)}
                </MetaRow>
                <MetaRow icon={CircleDot} label="Status">
                  <Badge variant={ticketStatusVariant(status)}>
                    {TICKET_STATUS_LABEL[status]}
                  </Badge>
                </MetaRow>
                <MetaRow icon={Tag} label="Priority">
                  <Badge variant={ticketPriorityVariant(priority)}>
                    {TICKET_PRIORITY_LABEL[priority]}
                  </Badge>
                </MetaRow>
                <MetaRow icon={Folder} label="Category">
                  {categoryLabel(category)}
                </MetaRow>
                <MetaRow icon={User} label="Requester">
                  {assigneeLabel(requesterEmail) === "Unassigned"
                    ? requesterLabel(ticket)
                    : assigneeLabel(requesterEmail)}
                </MetaRow>
                <MetaRow icon={User} label="Assignee">
                  {assigneeLabel(
                    assigneeEmail.trim() || ticket.assigneeEmail,
                  )}
                </MetaRow>
                <MetaRow icon={MapPin} label="Location">
                  {assetId === ticket.assetId
                    ? (ticket.locationLabel ?? "—")
                    : assetId
                      ? "Updates after save"
                      : "—"}
                </MetaRow>
                <MetaRow icon={Calendar} label="Created">
                  {fmtDateTime(ticket.createdAt)}
                </MetaRow>
                <MetaRow icon={Calendar} label="Updated">
                  {fmtDateTime(ticket.updatedAt)}
                </MetaRow>
              </dl>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle>Related Assets</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <AssetLinkEditor
                tag={displayAssetTag}
                name={displayAssetName}
                compact
                pickerOpen={assetPickerOpen}
                onTogglePicker={() => {
                  setAssetPickerOpen((o) => !o);
                  if (!assetPickerOpen) setTab("assets");
                }}
                onUnlink={() => {
                  applyAssetId(null);
                  setAssetPickerOpen(false);
                }}
                assets={linkAssets}
                assetId={assetId}
                onPick={(id) => {
                  applyAssetId(id);
                  if (id) setAssetPickerOpen(false);
                }}
              />
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle>Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full px-2.5 text-xs"
                  disabled
                  title="Tags coming soon"
                >
                  + Add
                </Button>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                Tags coming soon.
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function AssetLinkEditor({
  tag,
  name,
  compact = false,
  pickerOpen,
  onTogglePicker,
  onUnlink,
  assets,
  assetId,
  onPick,
}: {
  tag: string | null;
  name: string | null;
  compact?: boolean;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onUnlink: () => void;
  assets: LinkAsset[];
  assetId: string | null;
  onPick: (assetId: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {tag ? (
        <div className="flex flex-col gap-2">
          <Link
            href={`/assets/${tag}`}
            className={cn(
              "hover:bg-muted/50 flex items-center gap-3 rounded-lg border p-2.5 transition-colors",
              !compact && "rounded-xl bg-card p-3",
            )}
          >
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <Laptop className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{name ?? tag}</p>
              <p className="text-muted-foreground truncate font-mono text-xs">
                {tag}
              </p>
            </div>
            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
          </Link>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onTogglePicker}
            >
              {pickerOpen ? "Hide picker" : "Change"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onUnlink}>
              Unlink
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">No linked asset.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={onTogglePicker}
          >
            {pickerOpen ? "Hide picker" : "Link asset"}
          </Button>
        </div>
      )}

      {pickerOpen && !compact ? (
        <TicketAssetPicker
          assets={assets}
          value={assetId}
          onChange={onPick}
        />
      ) : null}

      {!compact && (assetId !== null || tag) ? (
        <p className="text-muted-foreground text-xs">
          Click Update to save asset changes. Location and requester follow the
          linked asset when the device has an owner.
        </p>
      ) : null}
    </div>
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

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon
        className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="min-w-0 text-right font-medium">{children}</dd>
      </div>
    </div>
  );
}
