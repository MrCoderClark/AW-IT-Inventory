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
import { ASSETS, TYPE_ICON, type Asset } from "@/lib/data";
import { cn } from "@/lib/utils";

/* Deterministic pseudo-metrics so the mock health looks stable per asset. */
function hashPct(seed: string, min = 8, max = 92) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return min + (h % (max - min));
}

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

function HealthRing({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="relative size-20 rounded-full"
        style={{
          background: `conic-gradient(var(--primary) ${pct}%, var(--muted) 0)`,
        }}
      >
        <div className="absolute inset-[9px] grid place-content-center rounded-full bg-card text-center">
          <span className="text-base font-bold tabular-nums">{pct}%</span>
        </div>
      </div>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
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

export function AssetDetailDrawer() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = searchParams.get("asset");
  const asset = id ? ASSETS.find((a) => a.id === id) ?? null : null;

  const close = () => router.push(pathname, { scroll: false });

  const showHealth = asset
    ? asset.type === "Computer" || asset.type === "Printer"
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

              {/* Live-scan health (mock) */}
              {showHealth && (
                <>
                  <Separator />
                  <div>
                    <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Live scan · via collector · 02:00
                    </p>
                    <div className="flex items-center justify-around rounded-xl border bg-card p-4">
                      <HealthRing pct={hashPct(asset.serial + "d")} label="Disk" />
                      <HealthRing pct={hashPct(asset.serial + "r")} label="RAM" />
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-base font-bold tabular-nums">
                          {hashPct(asset.serial + "u", 1, 40)}d
                        </span>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Uptime
                        </span>
                      </div>
                    </div>
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
