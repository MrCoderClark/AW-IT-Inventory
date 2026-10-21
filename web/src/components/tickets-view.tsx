"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { ticketsToCsv } from "@/lib/ticket-csv";

import { fmtDateTime } from "@/components/detail-ui";
import { NewTicketDialog } from "@/components/new-ticket-dialog";
import { TicketKpiStrip } from "@/components/ticket-kpi-strip";
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
import type {
  LinkAsset,
  TicketListItem,
  TicketPriority,
  TicketStatus,
} from "@/lib/data";
import { ticketSlaState } from "@/lib/ticket-sla";
import {
  assigneeLabel,
  categoryLabel,
  requesterLabel,
  ticketNumberLabel,
  ticketPriorityVariant,
  TICKET_CATEGORIES,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  ticketStatusVariant,
} from "@/lib/ticket-ui";

const ALL = "__all__";
const UNASSIGNED = "__unassigned__";
const PAGE = 10;

const STATUSES: TicketStatus[] = [
  "open",
  "in_progress",
  "waiting_on_user",
  "resolved",
  "closed",
];
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
  linkAssets = [],
  viewerEmail: _viewerEmail,
}: {
  initialTickets: TicketListItem[];
  linkAssets?: LinkAsset[];
  viewerEmail: string;
}) {
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState(ALL);
  const [priorityFilter, setPriorityFilter] = React.useState(ALL);
  const [categoryFilter, setCategoryFilter] = React.useState(ALL);
  const [assigneeFilter, setAssigneeFilter] = React.useState(ALL);
  const [page, setPage] = React.useState(0);

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

  React.useEffect(() => {
    setPage(0);
  }, [query, statusFilter, priorityFilter, categoryFilter, assigneeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(
    clampedPage * PAGE,
    clampedPage * PAGE + PAGE,
  );

  function onDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open) router.refresh();
  }

  function onTicketCreated(ticketId: string | undefined) {
    if (ticketId) router.push(`/tickets/${ticketId}`);
    router.refresh();
  }

  function exportCsv() {
    if (filtered.length === 0) {
      toast.error("Nothing to export", {
        description: "No tickets match the current filters.",
      });
      return;
    }
    const csv = ticketsToCsv(filtered);
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `opus-tickets-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success("Export ready", {
      description: `${filtered.length} ticket${filtered.length === 1 ? "" : "s"} exported to CSV.`,
    });
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={filtered.length === 0}
              onClick={exportCsv}
            >
              <Download className="size-4" />
              Export
            </Button>
            <Button type="button" onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" />
              New Ticket
            </Button>
          </div>
        </div>

        <TicketKpiStrip tickets={initialTickets} />

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
              ...TICKET_CATEGORIES.map((c) => ({ value: c, label: c })),
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

        <div className="overflow-hidden rounded-xl border bg-card">
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
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ticket</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Requester</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>SLA</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>Location</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((t) => (
                    <TableRow
                      key={t.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/tickets/${t.id}`)}
                    >
                      <TableCell className="font-mono text-sm">
                        {ticketNumberLabel(t.number)}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate font-medium">
                        {t.subject}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {requesterLabel(t)}
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
                      <TableCell className="text-sm">
                        <SlaCell ticket={t} />
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                        {fmtDateTime(t.createdAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                        {fmtDateTime(t.updatedAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t.locationLabel ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4">
                <p className="text-muted-foreground text-sm">
                  {filtered.length}{" "}
                  {filtered.length === 1 ? "ticket" : "tickets"} ·{" "}
                  {clampedPage + 1} of {pageCount}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(p - 1, 0))}
                    disabled={clampedPage === 0}
                  >
                    Previous
                  </Button>
                  {Array.from({ length: pageCount }, (_, i) => (
                    <Button
                      key={i}
                      variant={clampedPage === i ? "default" : "outline"}
                      size="sm"
                      className="min-w-8 px-2"
                      onClick={() => setPage(i)}
                    >
                      {i + 1}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPage((p) => Math.min(p + 1, pageCount - 1))
                    }
                    disabled={clampedPage >= pageCount - 1}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <NewTicketDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        onCreated={onTicketCreated}
        linkAssets={linkAssets}
      />
    </>
  );
}

function SlaCell({ ticket }: { ticket: TicketListItem }) {
  const sla = ticketSlaState(ticket);
  return (
    <span
      className={
        sla.kind === "breached"
          ? "text-destructive font-medium"
          : sla.kind === "paused"
            ? "text-muted-foreground"
            : undefined
      }
    >
      {sla.label}
    </span>
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
