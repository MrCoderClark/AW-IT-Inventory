"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  BarChart3,
  Building2,
  Calendar,
  Copy,
  FileText,
  Hash,
  Loader2,
  MapPin,
  Monitor as MonitorIcon,
  MoreHorizontal,
  Network as NetworkIcon,
  Pencil,
  Printer,
  ShieldCheck,
  Sliders,
  Smartphone,
  Tag as TagIcon,
  Trash2,
  User,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { deleteAsset } from "@/app/(app)/assets/actions";
import {
  AssetFormDialog,
  type PersonOption,
} from "@/components/asset-form-dialog";
import { AssetImageUpload } from "@/components/asset-image-upload";
import { AssignmentControls } from "@/components/assignment-controls";
import {
  ActivityTable,
  AssignmentTimeline,
  InfoField,
  Panel,
  deriveActivity,
  fmtDate,
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
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import {
  type Asset,
  type AssignmentEvent,
  type LocationOption,
} from "@/lib/data";
import type { AssetFormValues } from "@/lib/asset-schema";
import { TYPE_FIELDS, detailsToFormValues, type TypeField } from "@/lib/asset-fields";

/** Per-type presentation for the thin categories (spec 17.05). */
const TYPE_META: Record<
  "Monitor" | "Phone" | "Network",
  { icon: React.ReactNode; route: string; backLabel: string }
> = {
  Monitor: { icon: <MonitorIcon className="size-3.5" />, route: "/monitors", backLabel: "Back to Monitors" },
  Phone: { icon: <Smartphone className="size-3.5" />, route: "/phones", backLabel: "Back to Phones" },
  Network: { icon: <NetworkIcon className="size-3.5" />, route: "/network", backLabel: "Back to Network" },
};

function fmtField(field: TypeField, row: Record<string, unknown> | null): string {
  if (!row) return "—";
  const v = row[field.key];
  if (v == null || v === "") return "—";
  if (field.bool) return v === true ? "Yes" : v === false ? "No" : "—";
  return String(v);
}

/**
 * The redesigned, tabbed detail for the thin asset categories — Monitor, Phone, and
 * Network (spec 17.05). Reuses the shared detail framework (`detail-ui`, `Tabs`,
 * `AssignmentControls`) built for computers. Tab sets: Monitor/Phone → Overview,
 * Assignment, Activity; Network → Overview, Network, Activity. No live scan or
 * software (those are computer/printer concerns); no new data.
 */
export function ThinAssetDetail({
  asset,
  details = null,
  assignmentHistory = [],
  assigneeId = null,
  people = [],
  locations = [],
  canWrite = false,
}: {
  asset: Asset;
  details?: Record<string, unknown> | null;
  assignmentHistory?: AssignmentEvent[];
  assigneeId?: string | null;
  people?: PersonOption[];
  locations?: LocationOption[];
  canWrite?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = React.useState("overview");
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isDeleting, startDelete] = React.useTransition();

  const type = asset.type as "Monitor" | "Phone" | "Network";
  const meta = TYPE_META[type] ?? TYPE_META.Monitor;
  const isAssignable = !TYPE_FIELDS[asset.type].hiddenShared.includes("assigneeId");
  const typeFields = TYPE_FIELDS[asset.type].fields;
  const activity = React.useMemo(
    () => deriveActivity(assignmentHistory),
    [assignmentHistory],
  );

  function confirmDelete() {
    startDelete(async () => {
      const res = await deleteAsset(asset.id);
      if (res.ok) {
        setConfirmOpen(false);
        toast.success(res.message);
        router.push(meta.route);
      } else {
        toast.error(res.error);
      }
    });
  }

  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(meta.route);
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

  /** The type-specific spec-10 field grid (Overview for Monitor/Phone, the Network
     tab for Network). */
  const fieldGrid = (
    <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {typeFields.map((f) => (
        <InfoField
          key={f.key}
          icon={type === "Network" ? <Wifi /> : <Sliders />}
          label={f.label}
          value={fmtField(f, details)}
        />
      ))}
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-6">
      <button
        onClick={goBack}
        className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" />
        {meta.backLabel}
      </button>

      {/* ---------------- Header ---------------- */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-5">
          <AssetImageUpload
            tag={asset.id}
            imageId={asset.imageId}
            imageVersion={asset.imageVersion}
            type={asset.type}
            name={asset.name}
            model={asset.model}
            canWrite={canWrite}
            boxClassName="h-[150px] w-[210px] max-w-full"
            iconClassName="size-12"
          />
          <div className="flex min-w-0 flex-col gap-2 pt-1">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
              {meta.icon}
              {asset.type}
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
          {isAssignable ? (
            <TabsTab value="assignment">Assignment</TabsTab>
          ) : (
            <TabsTab value="network">Network</TabsTab>
          )}
          <TabsTab value="activity">Activity</TabsTab>
        </TabsList>

        {/* -------- Overview -------- */}
        <TabsPanel value="overview" className="flex flex-col gap-5">
          <Panel icon={<FileText />} title="Asset Information">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <InfoField icon={<TagIcon />} label="Model" value={asset.model || "—"} />
              <InfoField icon={<Hash />} label="Serial Number" value={asset.serial || "—"} mono />
              {isAssignable && (
                <InfoField icon={<User />} label="Assigned To" value={asset.assignee?.name ?? "— Available"} />
              )}
              <InfoField icon={<MapPin />} label="Location" value={asset.location || "—"} />
              <InfoField icon={<Calendar />} label="Purchase Date" value={fmtDate(asset.purchaseDate)} mono />
              <InfoField icon={<Building2 />} label="Vendor" value={asset.vendor || "—"} />
              <InfoField icon={<ShieldCheck />} label="Warranty Until" value={fmtDate(asset.warrantyUntil)} mono />
              <InfoField icon={<BarChart3 />} label="Cost Center" value={asset.costCenter || "—"} mono />
              <InfoField icon={<FileText />} label="Specification" value={asset.spec || "—"} mono />
            </div>
          </Panel>

          {/* Monitor/Phone show their spec-10 fields on Overview; Network shows them
             on its own Network tab instead. */}
          {isAssignable && typeFields.length > 0 && (
            <Panel icon={<Sliders />} title={`${asset.type} Details`}>
              {fieldGrid}
            </Panel>
          )}
        </TabsPanel>

        {/* -------- Assignment (Monitor/Phone) -------- */}
        {isAssignable && (
          <TabsPanel value="assignment" className="flex flex-col gap-5">
            {canWrite && (
              <Panel icon={<User />} title="Assign Device">
                <AssignmentControls
                  assetId={asset.id}
                  hasAssignee={!!asset.assignee}
                  people={people}
                />
              </Panel>
            )}
            <Panel icon={<ActivityIcon />} title="Assignment History">
              <AssignmentTimeline history={assignmentHistory} />
            </Panel>
          </TabsPanel>
        )}

        {/* -------- Network (Network only) -------- */}
        {!isAssignable && (
          <TabsPanel value="network">
            <Panel icon={<Wifi />} title="Network">
              {typeFields.length > 0 ? (
                fieldGrid
              ) : (
                <p className="text-sm text-muted-foreground">
                  No network details recorded yet.
                </p>
              )}
            </Panel>
          </TabsPanel>
        )}

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
            <DialogTitle>Delete this {asset.type.toLowerCase()}?</DialogTitle>
            <DialogDescription>
              {asset.name} ({asset.id}) will be permanently removed. This can&apos;t
              be undone.
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
              Delete {asset.type.toLowerCase()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
