"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
  Link2 as LinkIcon,
  Loader2,
  MapPin,
  MemoryStick,
  Monitor,
  MonitorCog,
  Network,
  MoreHorizontal,
  Package,
  Pencil,
  PenLine,
  Printer,
  ScanLine,
  ShieldCheck,
  Tag as TagIcon,
  TerminalSquare,
  Trash2,
  User,
} from "lucide-react";
import { toast } from "sonner";

import { deleteAsset } from "@/app/(app)/assets/actions";
import { requestScan } from "@/app/(app)/scan-actions";
import {
  AssetFormDialog,
  type PersonOption,
} from "@/components/asset-form-dialog";
import { AssetImageUpload } from "@/components/asset-image-upload";
import { AssignmentControls } from "@/components/assignment-controls";
import { CompliancePanel } from "@/components/compliance-panel";
import { DeviceMonitoring } from "@/components/device-monitoring";
import { PrinterInstallPanel } from "@/components/printer-install-panel";
import { UpdatesPanel } from "@/components/updates-panel";
import type { DeviceMetrics } from "@/db/metrics";
import type { ComputerPatches } from "@/db/patches";
import type { MissingCheckListItem } from "@/db/missing-update-checks";
import type { PatchInstallListItem } from "@/db/patch-install";
import type { RebootListItem } from "@/db/reboot";
import type { ScheduleListItem } from "@/db/reboot-schedules";
import type { CompliancePosture } from "@/lib/compliance-score";
import type {
  PackageOption,
  PrinterOption,
} from "@/components/printer-install-dialog";
import type {
  InstallJobListItem,
  PrinterListSnapshot,
} from "@/db/printer-install";
import {
  ActivityTable,
  AssignmentTimeline,
  InfoField,
  Panel,
  deriveActivity,
  fmtDate,
} from "@/components/detail-ui";
import { RemoteTerminal } from "@/components/remote-terminal";
import {
  RemoteSessionHistory,
  type RemoteSessionHistoryItem,
} from "@/components/remote-session-history";
import type { ConnectedMonitorItem } from "@/db/monitors";
import type { SignaturePadItem } from "@/db/signature-pads";
import {
  SoftwareDeployPanel,
  type DeployHistoryItem,
  type DeployPackageOption,
} from "@/components/software-deploy-panel";
import {
  ScriptRunPanel,
  type ScriptOption,
} from "@/components/script-run-panel";
import type { ScriptRunListItem } from "@/db/script-runs";
import {
  AiAssistPanel,
  type AssistJobView,
} from "@/components/ai-assist-panel";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
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
  type InstalledSoftwareItem,
  type LocationOption,
  type MachineSummary,
} from "@/lib/data";
import type { AssetFormValues } from "@/lib/asset-schema";
import { TYPE_FIELDS, detailsToFormValues, type TypeField } from "@/lib/asset-fields";

/** Short label for a printer-install job status (Overview summary + tab). */
const INSTALL_STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  claimed: "Installing…",
  running: "Installing…",
  succeeded: "Installed",
  failed: "Failed",
  canceled: "Canceled",
};

/** Format one spec-10 computer field for display. */
function fmtField(field: TypeField, row: Record<string, unknown> | null): string {
  if (!row) return "—";
  const v = row[field.key];
  if (v == null || v === "") return "—";
  if (field.bool) return v === true ? "Yes" : v === false ? "No" : "—";
  return String(v);
}

/** Metrics + optional AI Assist under Monitoring (specs 29 + 34). */
function MonitoringBody({
  metrics,
  aiEnabled,
  assetTag,
  canDeploy,
  latestScriptJobId,
  recentAssistJobs = [],
  assistJobId = null,
}: {
  metrics: DeviceMetrics;
  aiEnabled: boolean;
  assetTag: string;
  canDeploy: boolean;
  latestScriptJobId?: string | null;
  recentAssistJobs?: AssistJobView[];
  assistJobId?: string | null;
}) {
  const [sub, setSub] = React.useState<"metrics" | "assist">(
    assistJobId ? "assist" : "metrics",
  );

  if (!aiEnabled) {
    return <DeviceMonitoring metrics={metrics} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex gap-1 border-b"
        role="tablist"
        aria-label="Monitoring view"
      >
        {(
          [
            ["metrics", "Metrics"],
            ["assist", "AI Assist"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={sub === id}
            className={
              sub === id
                ? "border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
            onClick={() => setSub(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === "metrics" ? (
        <DeviceMonitoring metrics={metrics} />
      ) : (
        <AiAssistPanel
          assetTag={assetTag}
          canDeploy={canDeploy}
          latestScriptJobId={latestScriptJobId}
          recentJobs={recentAssistJobs}
          initialJobId={assistJobId}
        />
      )}
    </div>
  );
}

/** Terminal + Scripts sub-tabs on Remote Actions (specs 24 + 32). */
function RemoteActionsBody({
  assetTag,
  canRemote,
  canDeploy,
  remoteSessions,
  scriptOptions,
  scriptRuns,
  hasIp,
}: {
  assetTag: string;
  canRemote: boolean;
  canDeploy: boolean;
  remoteSessions: RemoteSessionHistoryItem[];
  scriptOptions: ScriptOption[];
  scriptRuns: ScriptRunListItem[];
  hasIp: boolean;
}) {
  const defaultSub = canRemote ? "terminal" : "scripts";
  const [sub, setSub] = React.useState(defaultSub);

  // Only one capability → no inner tabs, just the panel.
  if (canRemote && !canDeploy) {
    return (
      <>
        <Panel icon={<TerminalSquare />} title="Remote Terminal">
          <RemoteTerminal assetTag={assetTag} />
        </Panel>
        <RemoteSessionHistory sessions={remoteSessions} />
      </>
    );
  }
  if (canDeploy && !canRemote) {
    return (
      <ScriptRunPanel
        assetTag={assetTag}
        scripts={scriptOptions}
        initialHistory={scriptRuns}
        hasIp={hasIp}
      />
    );
  }

  // Plain buttons — nested <Tabs> would fight the page-level tab context.
  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex gap-1 border-b"
        role="tablist"
        aria-label="Remote action type"
      >
        {(
          [
            ["terminal", "Remote Terminal"],
            ["scripts", "Scripts"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={sub === id}
            className={
              sub === id
                ? "border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
            onClick={() => setSub(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === "terminal" ? (
        <div className="flex flex-col gap-5">
          <Panel icon={<TerminalSquare />} title="Remote Terminal">
            <RemoteTerminal assetTag={assetTag} />
          </Panel>
          <RemoteSessionHistory sessions={remoteSessions} />
        </div>
      ) : (
        <ScriptRunPanel
          assetTag={assetTag}
          scripts={scriptOptions}
          initialHistory={scriptRuns}
          hasIp={hasIp}
        />
      )}
    </div>
  );
}

/**
 * The redesigned, tabbed computer detail page (spec 17.04). Reuses the shared
 * detail UI (`detail-ui`), the `Tabs` shell, and `AssignmentControls`; maps today's
 * computer panels — spec-10 fields, live scan health, tracked software (spec 15),
 * assignment + history (spec 16) — onto tabs without changing any behavior.
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
  canInstall = false,
  canRemote = false,
  remoteSessions = [],
  monitors = [],
  signaturePads = [],
  canDeploy = false,
  installJobs = [],
  installPackages = [],
  printerOptions = [],
  livePrinters = null,
  compliancePosture = null,
  patches = null,
  patchJobs = [],
  checkJobs = [],
  rebootJobs = [],
  rebootSchedule = null,
  deployPackages = [],
  deployHistory = [],
  scriptOptions = [],
  scriptRuns = [],
  metrics = { points: [], latest: null },
  aiEnabled = false,
  recentAssistJobs = [],
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
  canInstall?: boolean;
  canRemote?: boolean;
  remoteSessions?: RemoteSessionHistoryItem[];
  monitors?: ConnectedMonitorItem[];
  signaturePads?: SignaturePadItem[];
  canDeploy?: boolean;
  installJobs?: InstallJobListItem[];
  installPackages?: PackageOption[];
  printerOptions?: PrinterOption[];
  livePrinters?: PrinterListSnapshot | null;
  compliancePosture?: CompliancePosture | null;
  patches?: ComputerPatches | null;
  patchJobs?: PatchInstallListItem[];
  checkJobs?: MissingCheckListItem[];
  rebootJobs?: RebootListItem[];
  rebootSchedule?: ScheduleListItem | null;
  deployPackages?: DeployPackageOption[];
  deployHistory?: DeployHistoryItem[];
  scriptOptions?: ScriptOption[];
  scriptRuns?: ScriptRunListItem[];
  metrics?: DeviceMetrics;
  /** Spec 34 — when false/off, Assist panel is not rendered. */
  aiEnabled?: boolean;
  /** Newest assist jobs for this asset (spec 34 v2a). */
  recentAssistJobs?: AssistJobView[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const assistJobId = searchParams.get("assistJob");
  const openMonitoring =
    searchParams.get("tab") === "monitoring" || Boolean(assistJobId);
  const [tab, setTab] = React.useState(openMonitoring ? "monitoring" : "overview");
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isDeleting, startDelete] = React.useTransition();
  const [isScanning, startScan] = React.useTransition();

  const computerFields = TYPE_FIELDS.Computer.fields;
  const activity = React.useMemo(
    () => deriveActivity(assignmentHistory, machine),
    [assignmentHistory, machine],
  );

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
            imageVersion={asset.imageVersion}
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
          <TabsTab value="monitoring">Monitoring</TabsTab>
          <TabsTab value="livescan">Live scan</TabsTab>
          <TabsTab value="software">Software</TabsTab>
          <TabsTab value="updates">Updates</TabsTab>
          <TabsTab value="compliance">Compliance</TabsTab>
          <TabsTab value="printers">Printers</TabsTab>
          {(canRemote || canDeploy) && (
            <TabsTab value="remote">Remote Actions</TabsTab>
          )}
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
                    <InfoField icon={<User />} label="Logged in User" value={machine.loggedOnUser || "—"} mono />
                    <InfoField icon={<Clock />} label="Last seen" value={machine.lastSeen || "—"} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No scan data yet.</p>
                )}
              </Panel>

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

              <Panel
                icon={<Printer />}
                title="Printers"
                action={
                  <button
                    onClick={() => setTab("printers")}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Manage →
                  </button>
                }
              >
                {installJobs.filter((j) => j.action !== "list").length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No printer activity yet.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {installJobs
                      .filter((j) => j.action !== "list")
                      .slice(0, 3)
                      .map((j) => (
                      <li
                        key={j.id}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="min-w-0 truncate">{j.printerName}</span>
                        <span
                          className={
                            j.status === "failed"
                              ? "shrink-0 text-xs text-destructive"
                              : j.status === "succeeded"
                                ? "shrink-0 text-xs font-medium"
                                : "shrink-0 text-xs text-muted-foreground"
                          }
                        >
                          {INSTALL_STATUS_LABEL[j.status]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {canInstall && (
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => setTab("printers")}
                  >
                    <Printer className="size-4" /> Install printer
                  </Button>
                )}
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

          {/* -------- Connected displays (spec 25) -------- */}
          <Panel icon={<Monitor />} title="Connected Displays">
            {monitors.length > 0 ? (
              <ul className="divide-y text-sm">
                {monitors.map((m, i) => (
                  <li
                    key={`${m.serial ?? m.model}-${i}`}
                    className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {m.model || m.manufacturer || "Display"}
                        </span>
                        {!m.active && (
                          <Badge variant="outline" className="text-[10px]">
                            inactive
                          </Badge>
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {[
                          m.manufacturer,
                          m.year ? `${m.year}` : null,
                          m.diagonalIn ? `${m.diagonalIn}"` : null,
                          m.resolution,
                          m.refreshHz ? `${m.refreshHz} Hz` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {m.serial || "—"}
                      </span>
                      {/* Serial reconciliation (phase 3): link a matched Monitor
                         asset, or flag a scanned serial H2Tecs doesn't track. */}
                      {m.matchedAssetTag ? (
                        <Link
                          href={`/assets/${m.matchedAssetTag}`}
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          <LinkIcon className="size-3" />
                          {m.matchedAssetName || m.matchedAssetTag}
                        </Link>
                      ) : m.serial ? (
                        <Badge variant="outline" className="text-[10px] font-normal">
                          not in inventory
                        </Badge>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No displays detected. Monitors appear here after a Windows scan reads
                their EDID (a headless or virtual display may report none).
              </p>
            )}
          </Panel>

          {/* -------- Signature Pads (ePad peripheral scan) -------- */}
          {signaturePads.length > 0 && (
            <Panel icon={<PenLine />} title="Signature Pads">
              <ul className="divide-y text-sm">
                {signaturePads.map((pad, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {pad.name || "Signature Pad"}
                        </span>
                        {pad.connected ? (
                          <Badge
                            variant="default"
                            className="text-[10px]"
                          >
                            connected
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-[10px]"
                          >
                            not connected
                          </Badge>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </TabsPanel>

        {/* -------- Monitoring: metrics (29) + Assist (34) -------- */}
        <TabsPanel value="monitoring" className="flex flex-col gap-5">
          <MonitoringBody
            metrics={metrics}
            aiEnabled={aiEnabled}
            assetTag={asset.id}
            canDeploy={canDeploy}
            latestScriptJobId={scriptRuns[0]?.id ?? null}
            recentAssistJobs={recentAssistJobs}
            assistJobId={assistJobId}
          />
        </TabsPanel>

        <TabsPanel value="livescan" className="flex flex-col gap-5">
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

          {machine &&
            ((machine.networkAdapters && machine.networkAdapters.length > 0) ||
              (machine.loggedOnUsers && machine.loggedOnUsers.length > 0)) && (
              <Panel icon={<Network />} title="Network & sessions">
                {machine.networkAdapters && machine.networkAdapters.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      Network adapters
                    </p>
                    <ul className="divide-y text-sm">
                      {machine.networkAdapters.map((n) => (
                        <li
                          key={n.name}
                          className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                        >
                          <span className="font-medium">{n.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {n.mac ?? "—"}
                            {n.ips.length ? ` · ${n.ips.join(", ")}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {machine.loggedOnUsers && machine.loggedOnUsers.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      Active sessions ({machine.loggedOnUsers.length})
                    </p>
                    <ul className="flex flex-wrap gap-1.5">
                      {machine.loggedOnUsers.map((u) => (
                        <li
                          key={u}
                          className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs"
                        >
                          {u}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>
            )}
        </TabsPanel>

        {/* -------- Software -------- */}
        <TabsPanel value="software" className="flex flex-col gap-5">
          <Panel icon={<Package />} title="Tracked Software">
            {software.length > 0 ? (
              <ul className="divide-y text-sm">
                {software.map((s, i) => (
                  <li
                    key={`${s.name}-${s.version}-${i}`}
                    className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    {s.iconUrl ? (
                      <img
                        src={s.iconUrl}
                        alt=""
                        aria-hidden
                        className="size-6 shrink-0 rounded object-contain"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="grid size-6 shrink-0 place-items-center rounded bg-accent text-primary [&_svg]:size-3.5"
                      >
                        <Package />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{s.name}</span>
                        {s.architecture && (
                          <Badge variant="outline" className="shrink-0 font-mono text-[10px] uppercase">
                            {s.architecture}
                          </Badge>
                        )}
                      </span>
                      {s.publisher && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {s.publisher}
                        </span>
                      )}
                      {s.installLocation && (
                        <span
                          className="block truncate font-mono text-[11px] text-muted-foreground"
                          title={s.installLocation}
                        >
                          {s.installLocation}
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
          {canDeploy && (
            <SoftwareDeployPanel
              assetTag={asset.id}
              packages={deployPackages}
              initialHistory={deployHistory}
            />
          )}
        </TabsPanel>

        {/* -------- Updates (spec 31) -------- */}
        <TabsPanel value="updates">
          <UpdatesPanel
            patches={patches}
            assetTag={asset.id}
            canInstall={canDeploy}
            patchJobs={patchJobs}
            checkJobs={checkJobs}
            rebootJobs={rebootJobs}
            schedule={rebootSchedule}
          />
        </TabsPanel>

        {/* -------- Compliance -------- */}
        <TabsPanel value="compliance">
          <CompliancePanel posture={compliancePosture} />
        </TabsPanel>

        {/* -------- Printers -------- */}
        <TabsPanel value="printers">
          <PrinterInstallPanel
            assetTag={asset.id}
            canInstall={canInstall}
            hasIp={
              !!(details && typeof details.ipAddress === "string" && details.ipAddress)
            }
            packages={installPackages}
            printerOptions={printerOptions}
            jobs={installJobs}
            livePrinters={livePrinters}
          />
        </TabsPanel>

        {/* -------- Remote Actions: terminal (24) + scripts (32) -------- */}
        {(canRemote || canDeploy) && (
          <TabsPanel value="remote" className="flex flex-col gap-5">
            <RemoteActionsBody
              assetTag={asset.id}
              canRemote={canRemote}
              canDeploy={canDeploy}
              remoteSessions={remoteSessions}
              scriptOptions={scriptOptions}
              scriptRuns={scriptRuns}
              hasIp={
                !!(
                  details &&
                  typeof details.ipAddress === "string" &&
                  details.ipAddress
                )
              }
            />
          </TabsPanel>
        )}

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
            <AssignmentTimeline
              history={assignmentHistory}
              canViewPeople={canWrite}
            />
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
