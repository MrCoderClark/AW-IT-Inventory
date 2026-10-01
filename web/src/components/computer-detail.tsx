"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  BarChart3,
  Building2,
  Calendar,
  Clock,
  Copy,
  Cpu,
  FileText,
  Hash,
  HardDrive,
  Info,
  Loader2,
  MapPin,
  MemoryStick,
  MonitorCog,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Printer,
  ScanLine,
  ShieldCheck,
  Tag as TagIcon,
  Trash2,
  Undo2,
  User,
} from "lucide-react";
import { toast } from "sonner";

import { deleteAsset } from "@/app/(app)/assets/actions";
import {
  assignAssetAction,
  returnAssetAction,
} from "@/app/(app)/people-actions";
import { requestScan } from "@/app/(app)/scan-actions";
import {
  AssetFormDialog,
  type PersonOption,
} from "@/components/asset-form-dialog";
import { AssetImageUpload } from "@/components/asset-image-upload";
import {
  Dot,
  InfoField,
  Panel,
  fmtDate,
  fmtDateTime,
} from "@/components/detail-ui";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import {
  type Asset,
  type AssignmentEvent,
  type InstalledSoftwareItem,
  type LocationOption,
  type MachineSummary,
} from "@/lib/data";
import type { AssetFormValues } from "@/lib/asset-schema";
import { TYPE_FIELDS, detailsToFormValues, type TypeField } from "@/lib/asset-fields";
import { cn } from "@/lib/utils";

/** Format one spec-10 computer field for display. */
function fmtField(field: TypeField, row: Record<string, unknown> | null): string {
  if (!row) return "—";
  const v = row[field.key];
  if (v == null || v === "") return "—";
  if (field.bool) return v === true ? "Yes" : v === false ? "No" : "—";
  return String(v);
}

/** A derived activity event (assignment history + the last scan). Newest first. */
type ActivityEvent = { at: string; title: string; detail: string; ok: boolean };

function deriveActivity(
  history: AssignmentEvent[],
  machine?: MachineSummary,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const e of history) {
    events.push({
      at: e.assignedAt,
      title: "Assigned",
      detail: `To ${e.personName} by ${e.assignedBy}`,
      ok: true,
    });
    if (e.unassignedAt) {
      events.push({
        at: e.unassignedAt,
        title: "Returned",
        detail: `From ${e.personName}${e.unassignedBy ? ` by ${e.unassignedBy}` : ""}`,
        ok: false,
      });
    }
  }
  if (machine?.lastSeen) {
    events.push({
      at: machine.lastSeen,
      title: "Scanned",
      detail: machine.status ? `Collector · ${machine.status}` : "Collector sweep",
      ok: true,
    });
  }
  return events.sort((a, b) => +new Date(b.at) - +new Date(a.at));
}

function ActivityTable({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No activity yet. Assignments and collector scans appear here.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="pb-2 pr-4 font-semibold">Date &amp; Time</th>
            <th className="pb-2 pr-4 font-semibold">Event</th>
            <th className="pb-2 font-semibold">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {events.map((e, i) => (
            <tr key={`${e.title}-${e.at}-${i}`}>
              <td className="whitespace-nowrap py-2.5 pr-4 text-muted-foreground tabular-nums">
                {fmtDateTime(e.at)}
              </td>
              <td className="whitespace-nowrap py-2.5 pr-4 font-medium">
                {e.title}
              </td>
              <td className="py-2.5">
                <Dot
                  color={e.ok ? "var(--status-online)" : "var(--muted-foreground)"}
                >
                  {e.detail}
                </Dot>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The device's custody history (spec 16, AC-7), newest first. */
function AssignmentTimeline({ history }: { history: AssignmentEvent[] }) {
  if (history.length === 0) {
    return (
      <p className="rounded-xl border border-dashed bg-card/50 p-5 text-sm text-muted-foreground">
        No assignment history yet.
      </p>
    );
  }
  return (
    <ol className="relative ml-1 border-l pl-5">
      {history.map((e) => (
        <li key={e.id} className="relative pb-5 last:pb-0">
          <span
            className={cn(
              "absolute -left-[23px] top-1 size-2.5 rounded-full border-2 bg-card",
              e.open ? "border-primary" : "border-border",
            )}
          />
          <p className="text-sm">
            <Link
              href={`/people/${e.personId}`}
              className="font-medium hover:underline"
            >
              {e.personName}
            </Link>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Assigned {fmtDateTime(e.assignedAt)} by {e.assignedBy}
          </p>
          {e.open ? (
            <p className="mt-0.5 text-xs text-[color:var(--status-online)]">
              Currently held
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Returned {fmtDateTime(e.unassignedAt)} by {e.unassignedBy}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The redesigned, tabbed computer detail page (spec 17.04). Reuses the shared
 * detail UI (`detail-ui`) and the `Tabs` shell; maps today's computer panels —
 * spec-10 fields, live scan health, tracked software (spec 15), assignment +
 * history (spec 16) — onto tabs without changing any behavior.
 */
export function ComputerDetail({
  asset,
  machine,
  details = null,
  software = [],
  assignmentHistory = [],
  assigneeId = null,
  people = [],
  locations = [],
  canWrite = false,
  canScan = false,
}: {
  asset: Asset;
  machine?: MachineSummary;
  details?: Record<string, unknown> | null;
  software?: InstalledSoftwareItem[];
  assignmentHistory?: AssignmentEvent[];
  assigneeId?: string | null;
  people?: PersonOption[];
  locations?: LocationOption[];
  canWrite?: boolean;
  canScan?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = React.useState("overview");
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isDeleting, startDelete] = React.useTransition();
  const [isScanning, startScan] = React.useTransition();
  const [isAssigning, startAssign] = React.useTransition();
  const [assignPerson, setAssignPerson] = React.useState("");

  const computerFields = TYPE_FIELDS.Computer.fields;
  const activity = React.useMemo(
    () => deriveActivity(assignmentHistory, machine),
    [assignmentHistory, machine],
  );

  function assign() {
    if (!assignPerson) return;
    startAssign(async () => {
      const res = await assignAssetAction(asset.id, assignPerson);
      if (res.ok) {
        toast.success(res.message);
        setAssignPerson("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function returnDevice() {
    startAssign(async () => {
      const res = await returnAssetAction(asset.id);
      if (res.ok) {
        toast.success(res.message);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function scanNow() {
    startScan(async () => {
      const res = await requestScan("selected", [asset.id]);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  function confirmDelete() {
    startDelete(async () => {
      const res = await deleteAsset(asset.id);
      if (res.ok) {
        setConfirmOpen(false);
        toast.success(res.message);
        router.push("/computers");
      } else {
        toast.error(res.error);
      }
    });
  }

  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/computers");
  };

  const editValues: AssetFormValues = {
    name: asset.name,
    type: asset.type,
    status: asset.status,
    serial: asset.serial,
    model: asset.model,
    assigneeId: assigneeId ?? "",
    locationId: asset.locationId ?? "",
    vendor: asset.vendor,
    spec: asset.spec,
    costCenter: asset.costCenter,
    purchaseDate: asset.purchaseDate,
    warrantyUntil: asset.warrantyUntil,
  };
  const editDetails = detailsToFormValues(asset.type, details);

  return (
    <div className="flex w-full flex-col gap-6">
      <button
        onClick={goBack}
        className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" />
        Back to Computers
      </button>

      {/* ---------------- Header ---------------- */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-5">
          <AssetImageUpload
            tag={asset.id}
            imageId={asset.imageId}
            type="Computer"
            name={asset.name}
            model={asset.model}
            canWrite={canWrite}
            boxClassName="h-[150px] w-[210px] max-w-full"
            iconClassName="size-12"
          />
          <div className="flex min-w-0 flex-col gap-2 pt-1">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
              <Cpu className="size-3.5" />
              Computer
            </span>
            <h1 className="text-3xl font-bold tracking-tight">{asset.name}</h1>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(asset.id);
                  toast.success("Asset tag copied", { description: asset.id });
                }}
                className="inline-flex items-center gap-1.5 font-mono text-sm font-semibold text-muted-foreground hover:text-foreground"
              >
                {asset.id}
                <Copy className="size-3.5" />
              </button>
              <StatusBadge status={asset.status} />
            </div>
            {asset.model && (
              <p className="text-sm text-muted-foreground">{asset.model}</p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canWrite && (
            <Button onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" /> Edit
            </Button>
          )}
          {canScan && (
            <Button variant="outline" onClick={scanNow} disabled={isScanning}>
              {isScanning ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ScanLine className="size-4" />
              )}
              Scan now
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="icon" aria-label="More actions" />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={() =>
                  toast("Print label", {
                    description: "Label printing coming later.",
                  })
                }
              >
                <Printer className="size-4" /> Print label
              </DropdownMenuItem>
              {canWrite && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirmOpen(true)}
                  >
                    <Trash2 className="size-4" /> Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ---------------- Tabs ---------------- */}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList>
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="livescan">Live scan</TabsTab>
          <TabsTab value="software">Software</TabsTab>
          <TabsTab value="assignment">Assignment</TabsTab>
          <TabsTab value="activity">Activity</TabsTab>
        </TabsList>

        {/* -------- Overview -------- */}
        <TabsPanel value="overview" className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr]">
            <Panel icon={<Info />} title="Asset Information">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <InfoField icon={<TagIcon />} label="Model" value={asset.model || "—"} />
                <InfoField icon={<Hash />} label="Serial Number" value={asset.serial || "—"} mono />
                <InfoField icon={<User />} label="Assigned To" value={asset.assignee?.name ?? "— Available"} />
                <InfoField icon={<MapPin />} label="Location" value={asset.location || "—"} />
                <InfoField icon={<Calendar />} label="Purchase Date" value={fmtDate(asset.purchaseDate)} mono />
                <InfoField icon={<Building2 />} label="Vendor" value={asset.vendor || "—"} />
                <InfoField icon={<ShieldCheck />} label="Warranty Until" value={fmtDate(asset.warrantyUntil)} mono />
                <InfoField icon={<BarChart3 />} label="Cost Center" value={asset.costCenter || "—"} mono />
                <InfoField icon={<FileText />} label="Specification" value={asset.spec || "—"} mono />
              </div>
            </Panel>

            <div className="flex flex-col gap-5">
              {/* Live scan snapshot */}
              <Panel
                icon={<MonitorCog />}
                title="Live Scan"
                action={
                  <button
                    onClick={() => setTab("livescan")}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    View →
                  </button>
                }
              >
                {machine ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <InfoField icon={<MonitorCog />} label="OS" value={[machine.osName, machine.osVersion].filter(Boolean).join(" ") || "—"} />
                    <InfoField icon={<Cpu />} label="CPU" value={machine.cpu || "—"} />
                    <InfoField icon={<MemoryStick />} label="RAM" value={machine.ramGb != null ? `${machine.ramGb} GB` : "—"} />
                    <InfoField icon={<Clock />} label="Last seen" value={machine.lastSeen || "—"} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No scan data yet.</p>
                )}
              </Panel>

              {/* Assignment snapshot */}
              <Panel
                icon={<User />}
                title="Assignment"
                action={
                  <button
                    onClick={() => setTab("assignment")}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Manage →
                  </button>
                }
              >
                <p className="text-sm">
                  {asset.assignee ? (
                    <>
                      Currently held by{" "}
                      <span className="font-medium">{asset.assignee.name}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Unassigned — available in the pool</span>
                  )}
                </p>
              </Panel>
            </div>
          </div>

          {computerFields.length > 0 && (
            <Panel icon={<HardDrive />} title="Computer Details">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                {computerFields.map((f) => (
                  <InfoField
                    key={f.key}
                    icon={<HardDrive />}
                    label={f.label}
                    value={fmtField(f, details)}
                  />
                ))}
              </div>
            </Panel>
          )}
        </TabsPanel>

        {/* -------- Live scan -------- */}
        <TabsPanel value="livescan">
          <Panel
            icon={<MonitorCog />}
            title={`Live Scan${machine?.lastSeen ? ` · last seen ${machine.lastSeen}` : ""}`}
            action={
              canScan ? (
                <Button variant="outline" size="sm" onClick={scanNow} disabled={isScanning}>
                  {isScanning ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ScanLine className="size-4" />
                  )}
                  Scan now
                </Button>
              ) : undefined
            }
          >
            {machine ? (
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                <InfoField icon={<MonitorCog />} label="OS" value={[machine.osName, machine.osVersion].filter(Boolean).join(" ") || "—"} />
                <InfoField icon={<Cpu />} label="CPU" value={machine.cpu || "—"} />
                <InfoField icon={<MemoryStick />} label="RAM" value={machine.ramGb != null ? `${machine.ramGb} GB` : "—"} />
                <InfoField icon={<HardDrive />} label="Free disk" value={machine.freeDiskGb != null ? `${machine.freeDiskGb} GB` : "—"} />
                <InfoField icon={<Clock />} label="Uptime" value={machine.uptimeHours != null ? `${machine.uptimeHours} h` : "—"} />
                <InfoField icon={<ActivityIcon />} label="Scan status" value={machine.status || "—"} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No scan data yet — run the collector with{" "}
                <span className="font-mono">--ingest</span>.
              </p>
            )}
          </Panel>
        </TabsPanel>

        {/* -------- Software -------- */}
        <TabsPanel value="software">
          <Panel icon={<Package />} title="Tracked Software">
            {software.length > 0 ? (
              <ul className="divide-y text-sm">
                {software.map((s, i) => (
                  <li
                    key={`${s.name}-${s.version}-${i}`}
                    className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{s.name}</span>
                      {s.publisher && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {s.publisher}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {s.version || "—"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No tracked software found on this computer. Titles appear here once a
                Windows scan matches one from the watchlist (managed on Admin).
              </p>
            )}
          </Panel>
        </TabsPanel>

        {/* -------- Assignment -------- */}
        <TabsPanel value="assignment" className="flex flex-col gap-5">
          {canWrite && (
            <Panel icon={<User />} title="Assign Device">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={assignPerson || null}
                  onValueChange={(v) => setAssignPerson(v ?? "")}
                >
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue
                      placeholder={asset.assignee ? "Reassign to…" : "Assign to…"}
                    >
                      {(value) =>
                        people.find((p) => p.id === value)?.name ??
                        (asset.assignee ? "Reassign to…" : "Assign to…")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {people.length ? (
                      people.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="" disabled>
                        No active people — add someone first
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <Button onClick={assign} disabled={isAssigning || !assignPerson}>
                  {isAssigning ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  Assign
                </Button>
                {asset.assignee && (
                  <Button variant="outline" onClick={returnDevice} disabled={isAssigning}>
                    <Undo2 className="size-4" /> Return
                  </Button>
                )}
              </div>
            </Panel>
          )}
          <Panel icon={<ActivityIcon />} title="Assignment History">
            <AssignmentTimeline history={assignmentHistory} />
          </Panel>
        </TabsPanel>

        {/* -------- Activity -------- */}
        <TabsPanel value="activity">
          <Panel icon={<ActivityIcon />} title="Activity">
            <ActivityTable events={activity} />
          </Panel>
        </TabsPanel>
      </Tabs>

      {/* Edit form */}
      {canWrite && (
        <AssetFormDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          mode="edit"
          people={people}
          locations={locations}
          editTag={asset.id}
          initial={editValues}
          initialDetails={editDetails}
        />
      )}

      {/* Delete confirmation */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete this computer?</DialogTitle>
            <DialogDescription>
              {asset.name} ({asset.id}) will be permanently removed. A matched
              machine returns to the discovered inbox. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={isDeleting}>
              {isDeleting && <Loader2 className="size-4 animate-spin" />}
              Delete computer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
