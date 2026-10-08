"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Loader2,
  Printer,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  cancelInstallJobAction,
  removePrinterAction,
  scanPrintersAction,
} from "@/app/(app)/printer-install-actions";
import {
  PrinterInstallDialog,
  type PackageOption,
  type PrinterOption,
} from "@/components/printer-install-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { InstallJobListItem, PrinterListSnapshot } from "@/db/printer-install";

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusBadge(status: InstallJobListItem["status"], waiting: boolean) {
  if (status === "succeeded") return <Badge variant="outline">Done</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "canceled") return <Badge variant="secondary">Canceled</Badge>;
  if (status === "running" || status === "claimed")
    return <Badge variant="secondary">Working…</Badge>;
  return (
    <Badge variant="secondary">
      {waiting ? "Waiting for collector" : "Queued"}
    </Badge>
  );
}

function connLabel(c: InstallJobListItem["connection"]): string {
  if (!c) return "";
  if (c.type === "tcpip") return `TCP/IP ${c.host}${c.port ? `:${c.port}` : ""}`;
  if (c.type === "share") return c.sharePath;
  return "WSD";
}

function opLabel(j: InstallJobListItem): string {
  if (j.action === "remove") return `Remove ${j.printerName ?? ""}`;
  return `${j.printerName ?? ""} · ${j.packageId ?? ""} · ${connLabel(j.connection)}`;
}

export function PrinterInstallPanel({
  assetTag,
  canInstall,
  hasIp,
  packages,
  printerOptions,
  jobs,
  livePrinters,
}: {
  assetTag: string;
  canInstall: boolean;
  hasIp: boolean;
  packages: PackageOption[];
  printerOptions: PrinterOption[];
  jobs: InstallJobListItem[];
  livePrinters: PrinterListSnapshot | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  // Auto-refresh while any op is in flight (install / scan / remove).
  const hasActive = jobs.some(
    (j) => j.status === "pending" || j.status === "claimed" || j.status === "running",
  );
  React.useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [hasActive, router]);

  // History = the mutating ops (install + remove); the "list" scans are hidden.
  const history = jobs.filter((j) => j.action !== "list");
  const scanInFlight = jobs.some(
    (j) =>
      j.action === "list" &&
      (j.status === "pending" || j.status === "claimed" || j.status === "running"),
  );
  // Printers OPUS installed here (by name), to badge the live list.
  const opusNames = new Set(
    jobs
      .filter((j) => j.action === "install" && j.printerName)
      .map((j) => j.printerName as string),
  );

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, id: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await fn();
      res.ok ? toast.success(res.message) : toast.error(res.error);
      setBusyId(null);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Printer className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Printers</h3>
        </div>
        {canInstall && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => run(() => scanPrintersAction(assetTag), "scan")}
              disabled={!hasIp || isPending || scanInFlight}
              title={hasIp ? undefined : "Add an IP to this computer first"}
            >
              {(busyId === "scan" || scanInFlight) && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              <RefreshCw className="size-4" /> Scan printers
            </Button>
            <Button
              size="sm"
              onClick={() => setOpen(true)}
              disabled={!hasIp}
              title={hasIp ? undefined : "Add an IP to this computer first"}
            >
              <Printer className="size-4" /> Install printer
            </Button>
          </div>
        )}
      </div>

      {!hasIp && canInstall && (
        <p className="mb-3 text-xs text-muted-foreground">
          This computer has no IP on record, so it can&apos;t be managed. Add its
          IP address first.
        </p>
      )}

      {/* On this computer (live Get-Printer snapshot) */}
      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            On this computer
          </p>
          {livePrinters && (
            <span className="text-[11px] text-muted-foreground">
              scanned {fmtWhen(livePrinters.scannedAt)}
            </span>
          )}
        </div>
        {!livePrinters ? (
          <p className="text-sm text-muted-foreground">
            {scanInFlight
              ? "Scanning…"
              : "Scan printers to see what's installed on this computer."}
          </p>
        ) : livePrinters.printers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No printers installed.</p>
        ) : (
          <ul className="divide-y text-sm">
            {livePrinters.printers.map((p) => (
              <li
                key={p.name}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="truncate">{p.name}</span>
                    {p.isDefault && <Badge variant="outline">Default</Badge>}
                    {p.shared && <Badge variant="secondary">Shared</Badge>}
                    {opusNames.has(p.name) && (
                      <Badge variant="secondary">Added by OPUS</Badge>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.driverName} · {p.hostAddress ?? p.portName}
                  </p>
                </div>
                {canInstall && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      run(() => removePrinterAction(assetTag, p.name), p.name)
                    }
                    disabled={isPending}
                  >
                    {busyId === p.name && (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                    <Trash2 className="size-4" /> Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Install / remove history */}
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Activity
      </p>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">No printer activity yet.</p>
      ) : (
        <ul className="divide-y text-sm">
          {history.map((j) => {
            const isOpen = expanded === j.id;
            const steps = j.result?.steps ?? [];
            return (
              <li key={j.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {j.action === "remove" ? "Removed" : "Installed"}{" "}
                      {j.printerName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {opLabel(j)} · {fmtWhen(j.requestedAt)} · {j.requestedBy}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(j.status, j.waitingForCollector)}
                    {(j.status === "pending" ||
                      j.status === "claimed" ||
                      j.status === "running") &&
                      canInstall && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const inFlight =
                              j.status === "claimed" || j.status === "running";
                            if (
                              inFlight &&
                              !window.confirm(
                                "This job may be running on the target now. Canceling releases it from the queue but won't undo changes already made on the machine. Cancel it anyway?",
                              )
                            )
                              return;
                            run(
                              () => cancelInstallJobAction(j.id, assetTag),
                              j.id,
                            );
                          }}
                          disabled={isPending}
                        >
                          Cancel
                        </Button>
                      )}
                    {(steps.length > 0 || j.error) && (
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : j.id)}
                        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent"
                        aria-label="Toggle details"
                      >
                        <ChevronDown
                          className={`size-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                    )}
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-2 rounded-lg border bg-muted/40 p-3 text-xs">
                    {j.error && <p className="mb-2 text-destructive">{j.error}</p>}
                    {steps.map((s, i) => (
                      <div key={i} className="mb-2 last:mb-0">
                        <p className="font-mono font-medium">
                          {s.name} — exit {s.exitCode ?? "—"}
                        </p>
                        {s.stdout && (
                          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-muted-foreground">
                            {s.stdout.slice(0, 2000)}
                          </pre>
                        )}
                        {s.stderr && (
                          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-destructive">
                            {s.stderr.slice(0, 2000)}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canInstall && (
        <PrinterInstallDialog
          open={open}
          onOpenChange={setOpen}
          assetTag={assetTag}
          packages={packages}
          printerOptions={printerOptions}
          onSuccess={() => router.refresh()}
        />
      )}
    </div>
  );
}
