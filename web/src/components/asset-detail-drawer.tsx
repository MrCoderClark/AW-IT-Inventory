"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Copy, Pencil, Printer, UserCog } from "lucide-react";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/status-badge";
import { TYPE_ICON, type Asset, type MachineSummary } from "@/lib/data";
import { cn } from "@/lib/utils";

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
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

export function AssetDetailDrawer({
  assets,
  machines,
}: {
  assets: Asset[];
  machines: Record<string, MachineSummary>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = searchParams.get("asset");
  const asset = id ? assets.find((a) => a.id === id) ?? null : null;
  const machine = asset ? machines[asset.id] : undefined;

  const close = () => router.push(pathname, { scroll: false });

  const showHealth = asset
    ? asset.type === "Computer" || asset.type === "Printer" || Boolean(machine)
    : false;
  const Icon = asset ? TYPE_ICON[asset.type] : null;

  return (
    <Sheet open={!!asset} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto sm:max-w-md"
      >
        {asset && Icon && (
          <>
            <SheetHeader className="gap-3">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="grid size-9 place-items-center rounded-lg bg-accent text-primary">
                  <Icon className="size-[18px]" />
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider">
                  {asset.type}
                </span>
              </div>
              <SheetTitle className="text-xl">{asset.name}</SheetTitle>
              <SheetDescription className="sr-only">
                Details for asset {asset.id}
              </SheetDescription>
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
            </SheetHeader>

            <div className="flex flex-col gap-6 px-4 pb-4">
              {/* Metadata */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                <Field label="Model" value={asset.model} />
                <Field label="Specification" value={asset.spec} mono />
                <Field
                  label="Assigned To"
                  value={asset.assignee?.name ?? "— Available"}
                />
                <Field label="Location" value={asset.location} />
                <Field label="Purchase Date" value={fmt(asset.purchaseDate)} mono />
                <Field
                  label="Warranty Until"
                  value={fmt(asset.warrantyUntil)}
                  mono
                />
                <Field label="Vendor" value={asset.vendor} />
                <Field label="Cost Center" value={asset.costCenter} mono />
              </div>

              {/* Live-scan data from the collector */}
              {showHealth && (
                <>
                  <Separator />
                  <div>
                    <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Live scan
                      {machine?.lastSeen ? ` · last seen ${machine.lastSeen}` : ""}
                    </p>
                    {machine ? (
                      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border bg-card p-4">
                        <Field
                          label="OS"
                          value={
                            [machine.osName, machine.osVersion]
                              .filter(Boolean)
                              .join(" ") || "—"
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
                            machine.freeDiskGb != null
                              ? `${machine.freeDiskGb} GB`
                              : "—"
                          }
                        />
                        <Field
                          label="Uptime"
                          value={
                            machine.uptimeHours != null
                              ? `${machine.uptimeHours} h`
                              : "—"
                          }
                        />
                        <Field label="Scan status" value={machine.status || "—"} />
                      </div>
                    ) : (
                      <p className="rounded-xl border border-dashed bg-card/50 p-4 text-sm text-muted-foreground">
                        No scan data yet — run the collector with{" "}
                        <span className="font-mono">--ingest</span>.
                      </p>
                    )}
                  </div>
                </>
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
              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={() =>
                    toast("Edit metadata", { description: "Form coming later." })
                  }
                >
                  <Pencil className="size-4" /> Edit
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    toast("Print label", { description: "Label printing coming later." })
                  }
                >
                  <Printer className="size-4" /> Print label
                </Button>
                <Button
                  variant="outline"
                  className="col-span-2"
                  onClick={() =>
                    toast("Reassign asset", { description: "Assignment flow coming later." })
                  }
                >
                  <UserCog className="size-4" /> Reassign
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
