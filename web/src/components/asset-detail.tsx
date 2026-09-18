"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Copy,
  Loader2,
  Pencil,
  Printer,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { deleteAsset } from "@/app/(app)/assets/actions";
import {
  AssetFormDialog,
  type PersonOption,
} from "@/components/asset-form-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/status-badge";
import {
  TYPE_ICON,
  type Asset,
  type AssetType,
  type MachineSummary,
} from "@/lib/data";
import type { AssetFormValues } from "@/lib/asset-schema";
import { cn } from "@/lib/utils";

const TYPE_ROUTE: Record<AssetType, string> = {
  Computer: "/computers",
  Monitor: "/monitors",
  Printer: "/printers",
  Phone: "/phones",
  Network: "/network",
};

function fmt(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 truncate text-sm", mono && "font-mono text-[13px]")}>
        {value}
      </p>
    </div>
  );
}

function AuditTimeline({ asset }: { asset: Asset }) {
  const events = [
    {
      what: asset.assignee
        ? `Assigned to ${asset.assignee.name}`
        : "Returned to pool",
      when: fmt(asset.lastSync),
    },
    { what: "Provisioned by IT Automation", when: fmt(asset.purchaseDate) },
    { what: "Received from warehouse", when: fmt(asset.purchaseDate) },
  ];
  return (
    <ol className="relative ml-1 border-l pl-5">
      {events.map((e, i) => (
        <li key={i} className="relative pb-4 last:pb-0">
          <span
            className={cn(
              "absolute -left-[23px] top-1 size-2.5 rounded-full border-2 bg-card",
              i === 0 ? "border-primary" : "border-border",
            )}
          />
          <p className="text-sm">{e.what}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{e.when}</p>
        </li>
      ))}
    </ol>
  );
}

/** The full asset detail, rendered as page content (replaces the old drawer). */
export function AssetDetail({
  asset,
  machine,
  canWrite = false,
  people = [],
  assigneeId = null,
}: {
  asset: Asset;
  machine?: MachineSummary;
  /** Show the write controls (Edit / Delete) only for `asset:write` users. */
  canWrite?: boolean;
  /** People for the assignee picker in the edit form. */
  people?: PersonOption[];
  /** The asset's current assignee id, to pre-select in the edit form. */
  assigneeId?: string | null;
}) {
  const Icon = TYPE_ICON[asset.type];
  const showHealth =
    asset.type === "Computer" || asset.type === "Printer" || Boolean(machine);

  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isDeleting, startDelete] = React.useTransition();

  // Return to wherever the user came from (a category page), falling back to
  // the dashboard on a direct load or refresh with no in-app history.
  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/dashboard");
  };

  // Pre-fill the edit form from the current values (the display Asset carries
  // everything as strings; the assignee id comes in separately).
  const editValues: AssetFormValues = {
    name: asset.name,
    type: asset.type,
    status: asset.status,
    serial: asset.serial,
    model: asset.model,
    assigneeId: assigneeId ?? "",
    location: asset.location,
    vendor: asset.vendor,
    spec: asset.spec,
    costCenter: asset.costCenter,
    purchaseDate: asset.purchaseDate,
    warrantyUntil: asset.warrantyUntil,
  };

  function confirmDelete() {
    startDelete(async () => {
      const res = await deleteAsset(asset.id);
      if (res.ok) {
        setConfirmOpen(false);
        toast.success(res.message);
        router.push(TYPE_ROUTE[asset.type] ?? "/dashboard");
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <button
        onClick={goBack}
        className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to inventory
      </button>

      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="grid size-9 place-items-center rounded-lg bg-accent text-primary">
            <Icon className="size-[18px]" />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider">
            {asset.type}
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{asset.name}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              navigator.clipboard?.writeText(asset.id);
              toast.success("Asset ID copied", { description: asset.id });
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-xs font-semibold hover:bg-accent hover:text-accent-foreground"
          >
            {asset.id}
            <Copy className="size-3" />
          </button>
          <StatusBadge status={asset.status} />
        </div>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl border bg-card p-5 sm:grid-cols-3">
        <Field label="Model" value={asset.model} />
        <Field label="Specification" value={asset.spec} mono />
        <Field label="Assigned To" value={asset.assignee?.name ?? "— Available"} />
        <Field label="Location" value={asset.location} />
        <Field label="Purchase Date" value={fmt(asset.purchaseDate)} mono />
        <Field label="Warranty Until" value={fmt(asset.warrantyUntil)} mono />
        <Field label="Vendor" value={asset.vendor} />
        <Field label="Cost Center" value={asset.costCenter} mono />
      </div>

      {/* Live-scan data from the collector */}
      {showHealth && (
        <div>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Live scan
            {machine?.lastSeen ? ` · last seen ${machine.lastSeen}` : ""}
          </p>
          {machine ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border bg-card p-5 sm:grid-cols-3">
              <Field
                label="OS"
                value={
                  [machine.osName, machine.osVersion].filter(Boolean).join(" ") ||
                  "—"
                }
              />
              <Field label="CPU" value={machine.cpu || "—"} />
              <Field
                label="RAM"
                value={machine.ramGb != null ? `${machine.ramGb} GB` : "—"}
              />
              <Field
                label="Free disk"
                value={
                  machine.freeDiskGb != null ? `${machine.freeDiskGb} GB` : "—"
                }
              />
              <Field
                label="Uptime"
                value={
                  machine.uptimeHours != null ? `${machine.uptimeHours} h` : "—"
                }
              />
              <Field label="Scan status" value={machine.status || "—"} />
            </div>
          ) : (
            <p className="rounded-xl border border-dashed bg-card/50 p-5 text-sm text-muted-foreground">
              No scan data yet — run the collector with{" "}
              <span className="font-mono">--ingest</span>.
            </p>
          )}
        </div>
      )}

      {/* Audit history */}
      <Separator />
      <div>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Audit History
        </p>
        <AuditTimeline asset={asset} />
      </div>

      {/* Actions */}
      <div className="grid max-w-md grid-cols-2 gap-2">
        {canWrite && (
          <Button onClick={() => setEditOpen(true)}>
            <Pencil className="size-4" /> Edit
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() =>
            toast("Print label", { description: "Label printing coming later." })
          }
        >
          <Printer className="size-4" /> Print label
        </Button>
        {canWrite && (
          <Button
            variant="destructive"
            className="col-span-2"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="size-4" /> Delete asset
          </Button>
        )}
      </div>

      {canWrite && (
        <AssetFormDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          mode="edit"
          people={people}
          editTag={asset.id}
          initial={editValues}
        />
      )}

      {/* Delete confirmation — an in-app dialog, never window.confirm. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete this asset?</DialogTitle>
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
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="size-4 animate-spin" />}
              Delete asset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
