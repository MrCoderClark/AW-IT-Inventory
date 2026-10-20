"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";

import { getTicketAction } from "@/app/(app)/ticket-actions";
import { NewTicketDialog } from "@/components/new-ticket-dialog";
import {
  TicketDetailPane,
  type TicketDetail,
} from "@/components/ticket-detail-pane";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TicketListItem, TicketPriority, TicketStatus } from "@/lib/data";
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

const ALL = "__all__";
const UNASSIGNED = "__unassigned__";

const STATUSES: TicketStatus[] = ["open", "in_progress", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "medium", "high"];

function filterTickets(
  tickets: TicketListItem[],
  q: string,
  status: string,
  priority: string,
  category: string,
  assignee: string,
): TicketListItem[] {
  const term = q.trim().toLowerCase();
  return tickets.filter((t) => {
    if (status !== ALL && t.status !== status) return false;
    if (priority !== ALL && t.priority !== priority) return false;
    if (category !== ALL && categoryLabel(t.category) !== category) return false;
    if (assignee === UNASSIGNED && t.assigneeEmail) return false;
    if (
      assignee !== ALL &&
      assignee !== UNASSIGNED &&
      t.assigneeEmail !== assignee
    ) {
      return false;
    }
    if (!term) return true;
    const hay = [
      ticketNumberLabel(t.number),
      t.subject,
      t.description,
      t.assetTag ?? "",
      t.category,
      t.assigneeEmail ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(term);
  });
}

export function TicketsView({
  initialTickets,
  initialTicketId = null,
}: {
  initialTickets: TicketListItem[];
  viewerEmail: string;
  initialTicketId?: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState(ALL);
  const [priorityFilter, setPriorityFilter] = React.useState(ALL);
  const [categoryFilter, setCategoryFilter] = React.useState(ALL);
  const [assigneeFilter, setAssigneeFilter] = React.useState(ALL);

  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialTicketId,
  );
  const [detail, setDetail] = React.useState<TicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const categories = React.useMemo(() => {
    const set = new Set<string>();
    for (const t of initialTickets) set.add(categoryLabel(t.category));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [initialTickets]);

  const assignees = React.useMemo(() => {
    const set = new Set<string>();
    for (const t of initialTickets) {
      if (t.assigneeEmail) set.add(t.assigneeEmail);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [initialTickets]);

  const filtered = React.useMemo(
    () =>
      filterTickets(
        initialTickets,
        query,
        statusFilter,
        priorityFilter,
        categoryFilter,
        assigneeFilter,
      ),
    [
      initialTickets,
      query,
      statusFilter,
      priorityFilter,
      categoryFilter,
      assigneeFilter,
    ],
  );

  const loadDetail = React.useCallback(async (id: string) => {
    setDetailLoading(true);
    const res = await getTicketAction(id);
    setDetailLoading(false);
    if (res.ok) {
      setDetail(res.ticket);
    } else {
      setDetail(null);
    }
  }, []);

  React.useEffect(() => {
    const fromUrl = searchParams.get("id");
    if (fromUrl) setSelectedId(fromUrl);
  }, [searchParams]);

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail, initialTickets]);

  function selectTicket(id: string) {
    setSelectedId(id);
    const params = new URLSearchParams(searchParams.toString());
    params.set("id", id);
    router.replace(`/tickets?${params.toString()}`, { scroll: false });
  }

  function onDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open) router.refresh();
  }

  function onTicketCreated(ticketId: string | undefined) {
    if (ticketId) selectTicket(ticketId);
    router.refresh();
  }

  function refreshDetail() {
    router.refresh();
    if (selectedId) void loadDetail(selectedId);
  }

  return (
    <>
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
            <p className="text-muted-foreground text-sm">
              Service tickets linked to assets and alerts.
            </p>
          </div>
          <Button type="button" onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" />
            New Ticket
          </Button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              className="pl-8"
              placeholder="Search tickets…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <FilterSelect
            label="Status"
            value={statusFilter}
            onValueChange={setStatusFilter}
            options={[
              { value: ALL, label: "All" },
              ...STATUSES.map((s) => ({
                value: s,
                label: TICKET_STATUS_LABEL[s],
              })),
            ]}
          />
          <FilterSelect
            label="Priority"
            value={priorityFilter}
            onValueChange={setPriorityFilter}
            options={[
              { value: ALL, label: "All" },
              ...PRIORITIES.map((p) => ({
                value: p,
                label: TICKET_PRIORITY_LABEL[p],
              })),
            ]}
          />
          <FilterSelect
            label="Category"
            value={categoryFilter}
            onValueChange={setCategoryFilter}
            options={[
              { value: ALL, label: "All" },
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
          />
          <FilterSelect
            label="Assignee"
            value={assigneeFilter}
            onValueChange={setAssigneeFilter}
            options={[
              { value: ALL, label: "All" },
              { value: UNASSIGNED, label: "Unassigned" },
              ...assignees.map((e) => ({
                value: e,
                label: assigneeLabel(e),
              })),
            ]}
          />
        </div>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 overflow-hidden rounded-xl border bg-card">
            {filtered.length === 0 ? (
              <div className="grid place-content-center gap-2 py-16 text-center">
                <p className="text-sm font-semibold">No tickets match</p>
                <p className="text-muted-foreground mx-auto max-w-sm text-sm">
                  {initialTickets.length === 0
                    ? "Create a ticket or wait for one from an alert notification."
                    : "Try clearing filters or search."}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ticket</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Assignee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((t) => {
                    const selected = t.id === selectedId;
                    return (
                      <TableRow
                        key={t.id}
                        data-state={selected ? "selected" : undefined}
                        className={cn(
                          "cursor-pointer",
                          selected && "bg-primary/5",
                        )}
                        onClick={() => selectTicket(t.id)}
                      >
                        <TableCell className="font-mono text-sm">
                          {ticketNumberLabel(t.number)}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate font-medium">
                          {t.subject}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {t.assetTag ?? "—"}
                        </TableCell>
                        <TableCell>{categoryLabel(t.category)}</TableCell>
                        <TableCell>
                          <Badge variant={ticketPriorityVariant(t.priority)}>
                            {TICKET_PRIORITY_LABEL[t.priority]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={ticketStatusVariant(t.status)}>
                            {TICKET_STATUS_LABEL[t.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {assigneeLabel(t.assigneeEmail)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          <TicketDetailPane
            ticket={detail}
            loading={detailLoading}
            onSaved={refreshDetail}
          />
        </div>
      </div>

      <NewTicketDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        onCreated={onTicketCreated}
      />
    </>
  );
}

function FilterSelect({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onValueChange(v ?? ALL)}
    >
      <SelectTrigger className="w-full sm:w-[140px]" size="sm">
        <span className="text-muted-foreground text-xs">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
