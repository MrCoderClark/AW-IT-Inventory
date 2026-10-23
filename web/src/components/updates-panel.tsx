"use client";

import * as React from "react";
import {
  ArrowRight,
  Loader2,
  Package,
  Power,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

import {
  pollUpdatesSnapshot,
  requestCancelPatchInstall,
  requestMissingUpdateCheck,
  requestPatchInstall,
} from "@/app/(app)/patch-install-actions";
import {
  requestCancelReboot,
  requestRebootSchedule,
} from "@/app/(app)/reboot-actions";
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
import { Dot, Panel, fmtDate, fmtDateTime } from "@/components/detail-ui";
import type { ComputerPatches } from "@/db/patches";
import type { MissingCheckListItem } from "@/db/missing-update-checks";
import type { PatchInstallListItem } from "@/db/patch-install";
import type { RebootListItem } from "@/db/reboot";

/**
 * Per-computer Updates tab (spec 31): inventory + Missing + optional Install
 * selected (phase 3, AC-18) for `software:deploy` admins.
 *
 * While a Check / install / reboot is in flight, polls a snapshot action and
 * updates local state only — no full page refresh.
 */

function lastUpdateLabel(days: number | null | undefined): string {
  if (days == null) return "—";
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

const JOB_STATUS: Record<string, string> = {
  pending: "Queued",
  claimed: "Installing…",
  running: "Installing…",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

const REBOOT_STATUS: Record<string, string> = {
  pending: "Scheduled",
  claimed: "Rebooting…",
  running: "Rebooting…",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

const ACTIVE = new Set(["pending", "claimed", "running"]);

function isActive(status: string): boolean {
  return ACTIVE.has(status);
}

export function UpdatesPanel({
  patches: patchesProp,
  assetTag,
  canInstall = false,
  patchJobs: patchJobsProp = [],
  checkJobs: checkJobsProp = [],
  rebootJobs: rebootJobsProp = [],
}: {
  patches: ComputerPatches | null;
  assetTag: string;
  canInstall?: boolean;
  patchJobs?: PatchInstallListItem[];
  checkJobs?: MissingCheckListItem[];
  rebootJobs?: RebootListItem[];
}) {
  const [patches, setPatches] = React.useState(patchesProp);
  const [patchJobs, setPatchJobs] = React.useState(patchJobsProp);
  const [checkJobs, setCheckJobs] = React.useState(checkJobsProp);
  const [rebootJobs, setRebootJobs] = React.useState(rebootJobsProp);
  const [osSel, setOsSel] = React.useState<Set<string>>(new Set());
  const [appSel, setAppSel] = React.useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [alsoReboot, setAlsoReboot] = React.useState(false);
  const [installRebootAt, setInstallRebootAt] = React.useState("");
  const [standaloneRebootAt, setStandaloneRebootAt] = React.useState("");
  const [busy, startBusy] = React.useTransition();
  const [flashMissing, setFlashMissing] = React.useState(false);
  const prevPatchStatus = React.useRef<Map<string, string>>(new Map());
  const prevCheckStatus = React.useRef<Map<string, string>>(new Map());
  const prevRebootStatus = React.useRef<Map<string, string>>(new Map());
  const prevMissingAt = React.useRef<string | null>(
    patchesProp?.missingCollectedAt ?? null,
  );

  // Keep in sync if the server re-renders the page (nav, soft navigation).
  React.useEffect(() => {
    setPatches(patchesProp);
    setPatchJobs(patchJobsProp);
    setCheckJobs(checkJobsProp);
    setRebootJobs(rebootJobsProp);
  }, [patchesProp, patchJobsProp, checkJobsProp, rebootJobsProp]);

  const inflight = patchJobs.some((j) => isActive(j.status));
  const checkInflight = checkJobs.some((j) => isActive(j.status));
  const rebootInflight = rebootJobs.some((j) => isActive(j.status));
  const live = inflight || checkInflight || rebootInflight;

  const applySnapshot = React.useCallback(
    (next: {
      patches: ComputerPatches | null;
      patchJobs: PatchInstallListItem[];
      checkJobs: MissingCheckListItem[];
      rebootJobs: RebootListItem[];
    }) => {
      // Toast when a job leaves in-flight.
      for (const j of next.patchJobs) {
        const prev = prevPatchStatus.current.get(j.id);
        if (prev && isActive(prev) && !isActive(j.status)) {
          if (j.status === "succeeded") toast.success("Patch install finished");
          else if (j.status === "failed")
            toast.error(j.error || "Patch install failed");
          else if (j.status === "canceled") toast.message("Patch install canceled");
        }
      }
      for (const j of next.checkJobs) {
        const prev = prevCheckStatus.current.get(j.id);
        if (prev && isActive(prev) && !isActive(j.status)) {
          if (j.status === "succeeded") toast.success("Updates checked");
          else if (j.status === "failed")
            toast.error(j.error || "Check for updates failed");
        }
      }
      for (const j of next.rebootJobs) {
        const prev = prevRebootStatus.current.get(j.id);
        if (prev && isActive(prev) && !isActive(j.status)) {
          if (j.status === "succeeded") toast.success("Reboot finished");
          else if (j.status === "failed")
            toast.error(j.error || "Reboot failed");
          else if (j.status === "canceled") toast.message("Reboot canceled");
        }
      }
      prevPatchStatus.current = new Map(
        next.patchJobs.map((j) => [j.id, j.status]),
      );
      prevCheckStatus.current = new Map(
        next.checkJobs.map((j) => [j.id, j.status]),
      );
      prevRebootStatus.current = new Map(
        next.rebootJobs.map((j) => [j.id, j.status]),
      );

      const nextMissingAt = next.patches?.missingCollectedAt ?? null;
      if (
        nextMissingAt &&
        nextMissingAt !== prevMissingAt.current &&
        prevMissingAt.current != null
      ) {
        setFlashMissing(true);
        window.setTimeout(() => setFlashMissing(false), 1200);
      }
      if (nextMissingAt) prevMissingAt.current = nextMissingAt;

      setPatches(next.patches);
      setPatchJobs(next.patchJobs);
      setCheckJobs(next.checkJobs);
      setRebootJobs(next.rebootJobs);
    },
    [],
  );

  // Seed status maps once so we don't toast for already-finished history.
  React.useEffect(() => {
    if (prevPatchStatus.current.size === 0) {
      prevPatchStatus.current = new Map(
        patchJobsProp.map((j) => [j.id, j.status]),
      );
    }
    if (prevCheckStatus.current.size === 0) {
      prevCheckStatus.current = new Map(
        checkJobsProp.map((j) => [j.id, j.status]),
      );
    }
    if (prevRebootStatus.current.size === 0) {
      prevRebootStatus.current = new Map(
        rebootJobsProp.map((j) => [j.id, j.status]),
      );
    }
  }, [patchJobsProp, checkJobsProp, rebootJobsProp]);

  React.useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = async () => {
      const res = await pollUpdatesSnapshot(assetTag);
      if (cancelled || !res.ok) return;
      applySnapshot(res);
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [live, assetTag, applySnapshot]);

  async function refreshSnapshot() {
    const res = await pollUpdatesSnapshot(assetTag);
    if (res.ok) applySnapshot(res);
  }

  if (!patches) {
    return (
      <Panel icon={<RefreshCw />} title="Updates">
        <p className="text-sm text-muted-foreground">
          No patch inventory yet. Scan this computer to collect installed KBs,
          pending reboot, and available app upgrades.
        </p>
        {canInstall && (
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={checkInflight || busy}
              onClick={() =>
                startBusy(async () => {
                  const res = await requestMissingUpdateCheck({ assetTag });
                  if (!res.ok) {
                    toast.error(res.error);
                    return;
                  }
                  toast.success("Check for updates queued");
                  await refreshSnapshot();
                })
              }
            >
              {checkInflight ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {checkInflight ? "Checking…" : "Check for updates"}
            </Button>
          </div>
        )}
      </Panel>
    );
  }

  const wingetNote =
    patches.wingetAvailable === false
      ? patches.wingetDetail
        ? `Winget not usable over WinRM: ${patches.wingetDetail}`
        : "Winget is not available on this PC (client missing or blocked)."
      : patches.wingetAvailable == null
        ? "App upgrade collect was skipped on the last scan."
        : null;

  function toggleOs(id: string) {
    setOsSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleApp(id: string) {
    setAppSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const selectedCount = osSel.size + appSel.size;

  function resetInstallDialog() {
    setAlsoReboot(false);
    setInstallRebootAt("");
  }

  function doInstall() {
    startBusy(async () => {
      const rebootAtIso =
        alsoReboot && installRebootAt.trim()
          ? new Date(installRebootAt).toISOString()
          : undefined;
      const res = await requestPatchInstall({
        assetTag,
        osKbIds: [...osSel],
        packageIds: [...appSel],
        rebootAtIso,
      });
      setConfirmOpen(false);
      resetInstallDialog();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        rebootAtIso ? "Patch install and reboot scheduled" : "Patch install queued",
      );
      if (res.rebootWarning) {
        toast.message(res.rebootWarning);
      }
      setOsSel(new Set());
      setAppSel(new Set());
      await refreshSnapshot();
    });
  }

  function doScheduleReboot() {
    if (!standaloneRebootAt.trim()) return;
    startBusy(async () => {
      const res = await requestRebootSchedule({
        assetTag,
        scheduledAtIso: new Date(standaloneRebootAt).toISOString(),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Reboot scheduled");
      setStandaloneRebootAt("");
      await refreshSnapshot();
    });
  }

  function doCancelReboot(jobId: string) {
    startBusy(async () => {
      const res = await requestCancelReboot({ id: jobId, assetTag });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Reboot canceled");
      await refreshSnapshot();
    });
  }

  function doCancel(jobId: string) {
    startBusy(async () => {
      const res = await requestCancelPatchInstall({ jobId, assetTag });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Canceled");
      await refreshSnapshot();
    });
  }

  function doCheck() {
    startBusy(async () => {
      const res = await requestMissingUpdateCheck({ assetTag });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Check for updates queued");
      await refreshSnapshot();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Panel icon={<RefreshCw />} title="Windows updates">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {patches.pendingReboot ? (
            <Badge variant="destructive" className="gap-1.5">
              <ShieldAlert className="size-3.5" />
              Pending reboot
            </Badge>
          ) : patches.pendingReboot === false ? (
            <Badge variant="outline" className="text-muted-foreground">
              <Dot color="var(--status-online)">No pending reboot</Dot>
            </Badge>
          ) : null}
          {patches.missingCount > 0 && (
            <Badge variant="destructive" className="gap-1.5">
              {patches.missingCount} missing
            </Badge>
          )}
          <span className="text-sm text-muted-foreground">
            Last successful update:{" "}
            <span className="font-medium text-foreground">
              {lastUpdateLabel(patches.updatesLastDays)}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            Collected {fmtDateTime(patches.collectedAt)}
          </span>
          {canInstall && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={checkInflight || busy}
              onClick={doCheck}
            >
              {checkInflight || busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {checkInflight ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>

        {patches.missingCollectedAt != null && (
          <div
            className={
              flashMissing
                ? "mb-4 rounded-lg ring-2 ring-primary/40 transition-[box-shadow] duration-700"
                : "mb-4"
            }
          >
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Missing OS updates
              {patches.missingCollectedAt
                ? ` · checked ${fmtDateTime(patches.missingCollectedAt)}`
                : ""}
            </p>
            {patches.missing.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No missing OS updates on the last Search.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      {canInstall && <th className="w-10 px-3 py-2" />}
                      <th className="px-3 py-2 font-medium">KB</th>
                      <th className="px-3 py-2 font-medium">Title</th>
                      <th className="px-3 py-2 font-medium">Severity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {patches.missing.map((m) => (
                      <tr key={m.kbId}>
                        {canInstall && (
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={osSel.has(m.kbId)}
                              onChange={() => toggleOs(m.kbId)}
                              disabled={inflight || busy}
                              aria-label={`Select ${m.kbId}`}
                            />
                          </td>
                        )}
                        <td className="px-3 py-2 font-mono text-xs">{m.kbId}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {m.title}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {m.severity || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Installed hotfixes
        </p>
        {patches.hotfixes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hotfixes reported on the last scan (QFE can be thin on modern
            Windows).
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">KB</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Installed</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {patches.hotfixes.map((h) => (
                  <tr key={h.hotfixId}>
                    <td className="px-3 py-2 font-mono text-xs">{h.hotfixId}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {h.description || "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
                      {fmtDate(h.installedOn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel icon={<Package />} title="App upgrades">
        {wingetNote && (
          <p className="mb-3 text-sm text-muted-foreground">{wingetNote}</p>
        )}
        {patches.wingetAvailable === true && patches.appUpgrades.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No winget upgrades waiting.
          </p>
        ) : patches.appUpgrades.length === 0 ? null : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  {canInstall && <th className="w-10 px-3 py-2" />}
                  <th className="px-3 py-2 font-medium">Package</th>
                  <th className="px-3 py-2 font-medium">Current</th>
                  <th className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium">Available</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {patches.appUpgrades.map((a) => (
                  <tr key={a.packageId}>
                    {canInstall && (
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={appSel.has(a.packageId)}
                          onChange={() => toggleApp(a.packageId)}
                          disabled={inflight || busy}
                          aria-label={`Select ${a.packageId}`}
                        />
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <span className="font-medium">{a.name}</span>
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                        {a.packageId}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
                      {a.version || "—"}
                    </td>
                    <td className="px-1 py-2 text-muted-foreground">
                      <ArrowRight className="size-3.5" aria-hidden />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs tabular-nums">
                      {a.available || "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {a.source || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {canInstall && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={selectedCount === 0 || inflight || busy}
            onClick={() => setConfirmOpen(true)}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Install selected
            {selectedCount > 0 ? ` (${selectedCount})` : ""}
          </Button>
          {inflight && (
            <span className="text-sm text-muted-foreground">
              A patch install is already in progress on this computer.
            </span>
          )}
        </div>
      )}

      {canInstall && (
        <Panel icon={<Power />} title="Scheduled reboot">
          <p className="mb-3 text-sm text-muted-foreground">
            Schedule a <strong>forced</strong> reboot at a specific date and time.
            The collector restarts the computer over WinRM with no desktop countdown.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                Reboot date and time
              </span>
              <input
                type="datetime-local"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={standaloneRebootAt}
                onChange={(e) => setStandaloneRebootAt(e.target.value)}
                disabled={rebootInflight || busy}
                aria-label="Reboot date and time"
              />
            </label>
            <Button
              disabled={!standaloneRebootAt.trim() || rebootInflight || busy}
              onClick={doScheduleReboot}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Power className="size-4" />
              )}
              Schedule reboot
            </Button>
          </div>
          {rebootInflight && (
            <p className="mt-2 text-sm text-muted-foreground">
              A reboot is already scheduled or in progress on this computer.
            </p>
          )}
        </Panel>
      )}

      {canInstall && rebootJobs.length > 0 && (
        <Panel icon={<Power />} title="Reboot history">
          <ul className="divide-y rounded-lg border">
            {rebootJobs.map((j) => (
              <li
                key={j.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium">
                    {REBOOT_STATUS[j.status] ?? j.status}
                  </span>
                  {j.sourcePatchInstallJobId ? (
                    <span className="text-muted-foreground"> · after install</span>
                  ) : null}
                  <span className="text-muted-foreground"> · {j.requestedBy}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {fmtDateTime(j.scheduledAt)}
                    {j.waitingForCollector ? " · waiting for collector" : ""}
                    {j.error ? ` · ${j.error}` : ""}
                  </span>
                </div>
                {(j.status === "pending" ||
                  j.status === "claimed" ||
                  j.status === "running") && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => doCancelReboot(j.id)}
                  >
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {canInstall && patchJobs.length > 0 && (
        <Panel icon={<RefreshCw />} title="Install history">
          <ul className="divide-y rounded-lg border">
            {patchJobs.map((j) => (
              <li
                key={j.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium">
                    {JOB_STATUS[j.status] ?? j.status}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {j.osCount} OS
                    {j.appCount ? ` + ${j.appCount} app` : ""} · {j.requestedBy}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {fmtDateTime(j.requestedAt)}
                    {j.waitingForCollector ? " · waiting for collector" : ""}
                    {j.error ? ` · ${j.error}` : ""}
                  </span>
                </div>
                {(j.status === "pending" ||
                  j.status === "claimed" ||
                  j.status === "running") && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => doCancel(j.id)}
                  >
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {confirmOpen ? (
        <Dialog
          open
          onOpenChange={(open) => {
            setConfirmOpen(open);
            if (!open) resetInstallDialog();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Install selected updates?</DialogTitle>
              <DialogDescription>
                {osSel.size} OS update{osSel.size === 1 ? "" : "s"} and{" "}
                {appSel.size} app upgrade{appSel.size === 1 ? "" : "s"} will be
                installed over WinRM.{" "}
                {alsoReboot ? (
                  <>
                    After install succeeds, the host will get a{" "}
                    <strong>forced</strong> reboot at the time below (or ASAP if
                    install finishes late).
                  </>
                ) : (
                  <>
                    The host will <strong>not</strong> be rebooted automatically.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 py-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={alsoReboot}
                  onChange={(e) => {
                    setAlsoReboot(e.target.checked);
                    if (!e.target.checked) setInstallRebootAt("");
                  }}
                  aria-label="Also reboot at"
                />
                Also reboot at…
              </label>
              {alsoReboot && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">
                    Reboot after install
                  </span>
                  <input
                    type="datetime-local"
                    className="rounded-md border bg-background px-2 py-1.5 text-sm"
                    value={installRebootAt}
                    onChange={(e) => setInstallRebootAt(e.target.value)}
                    aria-label="Reboot after install"
                  />
                </label>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy || (alsoReboot && !installRebootAt.trim())}
                onClick={doInstall}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                Install
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
