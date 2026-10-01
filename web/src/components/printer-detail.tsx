"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BarChart3,
  Building2,
  Calendar,
  Copy,
  ExternalLink,
  FileText,
  Hash,
  Info,
  Loader2,
  MapPin,
  MoreHorizontal,
  Palette,
  Pencil,
  Play,
  Printer as PrinterIcon,
  ScanLine,
  ShieldCheck,
  Tag as TagIcon,
  Trash2,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { deleteAsset } from "@/app/(app)/assets/actions";
import { requestScan, runPrinterCheckAction } from "@/app/(app)/scan-actions";
import { AssetFormDialog } from "@/components/asset-form-dialog";
import { AssetImageUpload } from "@/components/asset-image-upload";
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
  type AssetReachability,
  type LocationOption,
  type PrinterActivityEvent,
  type PrinterCounters,
  type PrinterNetworkHealth,
  type ReachabilityCheck,
  type ReachabilityState,
} from "@/lib/data";
import type { AssetFormValues } from "@/lib/asset-schema";
import { detailsToFormValues } from "@/lib/asset-fields";
import { cn } from "@/lib/utils";

/* ---------------- formatting helpers ---------------- */

function fmtDate(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function fmtDateTime(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(day: string | null | undefined) {
  if (!day) return "—";
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function fmtNumber(n: number | null | undefined) {
  return n == null ? "—" : n.toLocaleString("en-US");
}

/** A day's counter delta as human text (spec 14 rule). */
function fmtDelta(
  delta: number | null,
  note: "first-reading" | "counter-reset" | null,
): string {
  if (note === "first-reading") return "First reading";
  if (note === "counter-reset") return "Counter reset";
  if (delta == null) return "—";
  return `+${delta.toLocaleString("en-US")}`;
}

/* ---------------- small presentational pieces ---------------- */

/** A card matching the mock: a tinted icon tile, a title, an optional right-side
   action, then content. */
function Panel({
  icon,
  title,
  action,
  className,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col rounded-(--radius-card) bg-card p-5 ring-1 ring-foreground/10",
        className,
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-(--radius-control) bg-accent-soft text-primary [&_svg]:size-4"
          >
            {icon}
          </span>
          <h2 className="font-heading text-base font-semibold">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One labelled field with a muted leading icon (Asset Information card). */
function InfoField({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span aria-hidden className="mt-0.5 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className={cn("mt-0.5 truncate text-sm", mono && "font-mono text-[13px]")}>
          {value}
        </p>
      </div>
    </div>
  );
}

/** A "Label: value" line for the Printer Status card. */
function StatusRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

const STATE_META: Record<
  ReachabilityState,
  { label: string; online: string; color: string }
> = {
  up: { label: "Reachable", online: "Online", color: "var(--status-online)" },
  down: { label: "Down", online: "Offline", color: "var(--status-maintenance)" },
  unknown: { label: "Unknown", online: "Unknown", color: "var(--muted-foreground)" },
};

/** A coloured dot + text, e.g. "● Online". */
function Dot({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span style={{ color }}>{children}</span>
    </span>
  );
}

/** A soft status pill (e.g. the "Reachable" badge on Network Health). */
function StatePill({ state }: { state: ReachabilityState }) {
  const meta = STATE_META[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        color: meta.color,
        backgroundColor: `color-mix(in oklch, ${meta.color}, transparent 88%)`,
      }}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </span>
  );
}

/** A protocol row inside the Network Health sub-panel. `latency` null renders no
   latency (SNMP is never timed); `tracked=false` renders "Not tracked" (HTTP). */
function ProtocolRow({
  name,
  reachable,
  latencyMs,
  tracked = true,
}: {
  name: string;
  /** undefined = tracked but no reading yet; true/false = the latest result. */
  reachable?: boolean;
  latencyMs?: number | null;
  /** false = the protocol is not tracked at all (HTTP, deferred). */
  tracked?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="font-medium">{name}</span>
      {!tracked ? (
        <span className="text-xs text-muted-foreground">Not tracked</span>
      ) : reachable === undefined ? (
        <span className="text-xs text-muted-foreground">No reading yet</span>
      ) : (
        <span className="flex items-center gap-3">
          <Dot
            color={
              reachable ? "var(--status-online)" : "var(--status-maintenance)"
            }
          >
            <span className="text-xs">{reachable ? "Reachable" : "Unreachable"}</span>
          </Dot>
          {latencyMs != null && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {latencyMs} ms
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/* ---------------- the activity feed (shared by Overview + Activity tab) ------- */

function ActivityTable({ events }: { events: PrinterActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No activity yet. Health checks and counter reads appear here once the
        collector runs.
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
            <tr key={`${e.kind}-${e.at}-${i}`}>
              <td className="whitespace-nowrap py-2.5 pr-4 text-muted-foreground tabular-nums">
                {fmtDateTime(e.at)}
              </td>
              <td className="whitespace-nowrap py-2.5 pr-4 font-medium">
                {e.title}
              </td>
              <td className="py-2.5">
                <Dot
                  color={e.ok ? "var(--status-online)" : "var(--status-maintenance)"}
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

/* ---------------- the page ---------------- */

export function PrinterDetail({
  asset,
  details = null,
  reachability = null,
  networkHealth = null,
  counters = null,
  activity = [],
  canWrite = false,
  canScan = false,
  locations = [],
}: {
  asset: Asset;
  /** The printer's detail row (ip, colorMode, isDuplex, connection, mgmtUrl). */
  details?: Record<string, unknown> | null;
  /** Reachability rollup + recent checks (spec 12), for the Checks tab. */
  reachability?: {
    status: AssetReachability;
    history: ReachabilityCheck[];
  } | null;
  /** Network Health card data (spec 17.03, AC-3.5). */
  networkHealth?: PrinterNetworkHealth | null;
  /** Page-counter panel data (spec 14, AC-3). */
  counters?: PrinterCounters | null;
  /** Derived activity feed (spec 17.03, AC-3.6). */
  activity?: PrinterActivityEvent[];
  canWrite?: boolean;
  canScan?: boolean;
  /** Assignable leaf locations for the Edit form. */
  locations?: LocationOption[];
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isDeleting, startDelete] = React.useTransition();
  const [isChecking, startCheck] = React.useTransition();
  const [isScanning, startScan] = React.useTransition();
  // Controlled so the "View all / View history" links can switch tabs.
  const [tab, setTab] = React.useState("overview");

  const d = details ?? {};
  const ip =
    (d.ipAddress as string | undefined) || networkHealth?.ip || "";
  const colorMode = (d.colorMode as string | null) ?? null;
  const isDuplex = (d.isDuplex as boolean | null) ?? null;
  const connection = (d.connection as string | null) ?? null;
  const mgmtUrl = (d.mgmtUrl as string | null) || null;

  const state: ReachabilityState = networkHealth?.state ?? "unknown";
  const stateMeta = STATE_META[state];

  const colorModeLabel =
    colorMode === "mono"
      ? "Monochrome"
      : colorMode === "color"
        ? "Color"
        : "—";
  const connectionLabel =
    connection === "network"
      ? "Network"
      : connection === "USB"
        ? "USB"
        : connection || "—";
  const duplexLabel = isDuplex === true ? "Yes" : isDuplex === false ? "No" : "—";

  function runCheck() {
    startCheck(async () => {
      const res = await runPrinterCheckAction(asset.id);
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

  function openManagementUi() {
    if (mgmtUrl) window.open(mgmtUrl, "_blank", "noopener,noreferrer");
  }

  function confirmDelete() {
    startDelete(async () => {
      const res = await deleteAsset(asset.id);
      if (res.ok) {
        setConfirmOpen(false);
        toast.success(res.message);
        router.push("/printers");
      } else {
        toast.error(res.error);
      }
    });
  }

  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/printers");
  };

  // Prefill the edit form from the current values.
  const editValues: AssetFormValues = {
    name: asset.name,
    type: asset.type,
    status: asset.status,
    serial: asset.serial,
    model: asset.model,
    assigneeId: "",
    locationId: asset.locationId ?? "",
    vendor: asset.vendor,
    spec: asset.spec,
    costCenter: asset.costCenter,
    purchaseDate: asset.purchaseDate,
    warrantyUntil: asset.warrantyUntil,
  };
  const editDetails = detailsToFormValues(asset.type, details ?? null);

  const lastCounterSync =
    activity.find((e) => e.kind === "counter-sync")?.at ?? null;

  return (
    <div className="flex w-full flex-col gap-6">
      <button
        onClick={goBack}
        className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" />
        Back to Printers
      </button>

      {/* ---------------- Header ---------------- */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-5">
          <AssetImageUpload
            tag={asset.id}
            imageId={asset.imageId}
            type="Printer"
            name={asset.name}
            model={asset.model}
            canWrite={canWrite}
            boxClassName="h-[150px] w-[210px] max-w-full"
            iconClassName="size-12"
          />
          <div className="flex min-w-0 flex-col gap-2 pt-1">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
              <PrinterIcon className="size-3.5" />
              Printer
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
              <Dot color={stateMeta.color}>{stateMeta.online}</Dot>
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
            <Button variant="outline" onClick={runCheck} disabled={isChecking}>
              {isChecking ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Run Check
            </Button>
          )}
          <Button
            variant="outline"
            onClick={openManagementUi}
            disabled={!mgmtUrl}
            title={mgmtUrl ? undefined : "No management URL set for this printer"}
          >
            <ExternalLink className="size-4" /> Open Management UI
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="More actions"
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {canScan && (
                <DropdownMenuItem onClick={scanNow} disabled={isScanning}>
                  <ScanLine className="size-4" /> Scan now
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() =>
                  toast("Print label", {
                    description: "Label printing coming later.",
                  })
                }
              >
                <PrinterIcon className="size-4" /> Print label
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
          <TabsTab value="network">Network</TabsTab>
          <TabsTab value="counters">Counters</TabsTab>
          <TabsTab value="checks">Checks</TabsTab>
          <TabsTab value="activity">Activity</TabsTab>
        </TabsList>

        {/* -------- Overview -------- */}
        <TabsPanel value="overview" className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr_1fr]">
            {/* Asset Information (wider), then Network Health + Printer Status,
               all three across the top row to match the mock. */}
            <Panel icon={<Info />} title="Asset Information">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <InfoField icon={<TagIcon />} label="Model" value={asset.model || "—"} />
                <InfoField icon={<Hash />} label="Serial Number" value={asset.serial || "—"} mono />
                <InfoField icon={<MapPin />} label="Location" value={asset.location || "—"} />
                <InfoField icon={<Calendar />} label="Purchase Date" value={fmtDate(asset.purchaseDate)} mono />
                <InfoField icon={<Building2 />} label="Vendor" value={asset.vendor || "—"} />
                <InfoField icon={<ShieldCheck />} label="Warranty Until" value={fmtDate(asset.warrantyUntil)} mono />
                <InfoField icon={<BarChart3 />} label="Cost Center" value={asset.costCenter || "—"} mono />
                <InfoField icon={<FileText />} label="Specification" value={asset.spec || "—"} mono />
              </div>
            </Panel>

            {/* Network Health */}
            <Panel
              icon={<Wifi />}
              title="Network Health"
              action={<StatePill state={state} />}
            >
              <p className="font-mono text-xl font-bold">{ip || "—"}</p>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                IP Address
              </p>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <Calendar className="size-4 text-muted-foreground" />
                <span>
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Last Checked
                  </span>
                  {fmtDateTime(networkHealth?.lastCheckedAt)}
                </span>
              </div>
              <div className="mt-4 flex flex-col gap-2.5 rounded-(--radius-control) bg-[color:color-mix(in_oklch,var(--status-online),transparent_92%)] p-3">
                <ProtocolRow
                  name="TCP"
                  reachable={networkHealth?.tcp?.reachable}
                  latencyMs={networkHealth?.tcp?.latencyMs ?? null}
                />
                <ProtocolRow
                  name="SNMP"
                  reachable={networkHealth?.snmp?.reachable}
                  latencyMs={null}
                />
                <ProtocolRow name="HTTP" tracked={false} />
              </div>
            </Panel>

            {/* Printer Status */}
            <Panel icon={<PrinterIcon />} title="Printer Status">
              <div className="divide-y">
                <StatusRow label="Print Status">
                  <Dot color={stateMeta.color}>
                    {state === "up"
                      ? "Ready"
                      : state === "down"
                        ? "Offline"
                        : "Unknown"}
                  </Dot>
                </StatusRow>
                <StatusRow label="Color Mode">{colorModeLabel}</StatusRow>
                <StatusRow label="Duplex">{duplexLabel}</StatusRow>
                <StatusRow label="Connection">{connectionLabel}</StatusRow>
                <StatusRow label="Management UI">
                  {mgmtUrl ? (
                    <a
                      href={mgmtUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Open <ExternalLink className="size-3.5" />
                    </a>
                  ) : (
                    "—"
                  )}
                </StatusRow>
              </div>
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Recent Activity */}
            <Panel
              icon={<BarChart3 />}
              title="Recent Activity"
              action={
                <button
                  onClick={() => setTab("activity")}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  View all →
                </button>
              }
            >
              <ActivityTable events={activity.slice(0, 4)} />
            </Panel>

            {/* Counters */}
            <Panel
              icon={<BarChart3 />}
              title="Counters"
              action={
                <button
                  onClick={() => setTab("counters")}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  View history →
                </button>
              }
            >
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <FileText className="size-4" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider">
                      Total Pages
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-2xl font-bold tabular-nums">
                    {fmtNumber(counters?.latestTotal)}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <PrinterIcon className="size-4" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider">
                      Black &amp; White
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">Not tracked</p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Palette className="size-4" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider">
                      Color
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">Not tracked</p>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 rounded-(--radius-control) bg-muted/50 p-3 text-sm">
                <Calendar className="size-4 text-muted-foreground" />
                <span>
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Last Counter Sync
                  </span>
                  {lastCounterSync
                    ? fmtDateTime(lastCounterSync)
                    : fmtDay(counters?.latestDate)}
                </span>
              </div>
            </Panel>
          </div>
        </TabsPanel>

        {/* -------- Network -------- */}
        <TabsPanel value="network" className="flex flex-col gap-5">
          <Panel
            icon={<Wifi />}
            title="Network Health"
            action={<StatePill state={state} />}
          >
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
              <InfoField icon={<Wifi />} label="IP Address" value={ip || "—"} mono />
              <InfoField
                icon={<Calendar />}
                label="Last Checked"
                value={fmtDateTime(networkHealth?.lastCheckedAt)}
                mono
              />
              <InfoField
                icon={<PrinterIcon />}
                label="Reachability"
                value={<StatePill state={state} />}
              />
            </div>
            <div className="mt-4 flex flex-col gap-2.5 rounded-(--radius-control) bg-muted/40 p-3">
              <ProtocolRow
                name="TCP"
                reachable={networkHealth?.tcp?.reachable}
                latencyMs={networkHealth?.tcp?.latencyMs ?? null}
              />
              <ProtocolRow
                name="SNMP"
                reachable={networkHealth?.snmp?.reachable}
                latencyMs={null}
              />
              <ProtocolRow name="HTTP" tracked={false} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Run Check refreshes TCP reachability; SNMP and counters refresh on
              the daily sweep.
            </p>
            {canScan && (
              <div className="mt-4">
                <Button variant="outline" onClick={runCheck} disabled={isChecking}>
                  {isChecking ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  Run Check
                </Button>
              </div>
            )}
          </Panel>
          <ChecksPanel reachability={reachability} />
        </TabsPanel>

        {/* -------- Counters -------- */}
        <TabsPanel value="counters">
          <Panel icon={<BarChart3 />} title="Page Counter">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
              <InfoField
                icon={<FileText />}
                label="Total Pages"
                value={fmtNumber(counters?.latestTotal)}
                mono
              />
              <InfoField
                icon={<BarChart3 />}
                label="Today"
                value={fmtDelta(counters?.latestDelta ?? null, counters?.latestNote ?? null)}
                mono
              />
              <InfoField
                icon={<Calendar />}
                label="Last Reading"
                value={fmtDay(counters?.latestDate)}
                mono
              />
            </div>
            {counters && counters.history.length > 0 ? (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent daily history
                </p>
                <ul className="divide-y text-sm">
                  {counters.history.map((day) => (
                    <li
                      key={day.readingDate}
                      className="flex items-center justify-between gap-2 py-1.5"
                    >
                      <span className="text-muted-foreground">
                        {fmtDay(day.readingDate)}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="font-mono text-xs tabular-nums">
                          {day.totalPages.toLocaleString("en-US")}
                        </span>
                        <span
                          className={cn(
                            "font-mono text-xs tabular-nums",
                            day.note
                              ? "text-muted-foreground"
                              : "text-[color:var(--status-online)]",
                          )}
                        >
                          {fmtDelta(day.delta, day.note)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                No readings yet — the collector reads each printer&apos;s page
                counter on its daily SNMP collect.
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Black &amp; White and Color page splits are not tracked yet.
            </p>
          </Panel>
        </TabsPanel>

        {/* -------- Checks -------- */}
        <TabsPanel value="checks" className="flex flex-col gap-5">
          {canScan && (
            <div>
              <Button variant="outline" onClick={runCheck} disabled={isChecking}>
                {isChecking ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Run Check
              </Button>
            </div>
          )}
          <ChecksPanel reachability={reachability} />
        </TabsPanel>

        {/* -------- Activity -------- */}
        <TabsPanel value="activity">
          <Panel icon={<BarChart3 />} title="Activity">
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
          people={[]}
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
            <DialogTitle>Delete this printer?</DialogTitle>
            <DialogDescription>
              {asset.name} ({asset.id}) will be permanently removed. This
              can&apos;t be undone.
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
              Delete printer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The reachability check history (spec 12), reused by the Network and Checks
   tabs. */
function ChecksPanel({
  reachability,
}: {
  reachability?: {
    status: AssetReachability;
    history: ReachabilityCheck[];
  } | null;
}) {
  return (
    <Panel icon={<Wifi />} title="Reachability Checks">
      {reachability && reachability.history.length > 0 ? (
        <ul className="divide-y text-sm">
          {reachability.history.map((c, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 py-1.5"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{
                    backgroundColor: c.reachable
                      ? "var(--status-online)"
                      : "var(--status-maintenance)",
                  }}
                />
                <span className={c.reachable ? "" : "text-muted-foreground"}>
                  {c.reachable ? "Reachable" : "Unreachable"}
                </span>
                <span className="text-[11px] uppercase text-muted-foreground">
                  {c.method}
                </span>
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {c.latencyMs != null ? `${c.latencyMs} ms · ` : ""}
                {fmtDateTime(c.checkedAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No checks yet — the collector worker checks printers on its schedule
          (default 08:00, 13:00, 18:00).
        </p>
      )}
    </Panel>
  );
}
