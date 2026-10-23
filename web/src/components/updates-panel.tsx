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
  deleteRebootScheduleAction,
  requestCancelReboot,
  requestRebootSchedule,
  setRebootScheduleEnabledAction,
  upsertRebootScheduleAction,
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
import type { ScheduleListItem } from "@/db/reboot-schedules";
import {
  nextRebootOccurrence,
  type RebootCadence,
} from "@/lib/reboot-occurrence";

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

const WEEKDAYS: { iso: number; label: string }[] = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

type RebootHistoryItem = RebootListItem & { sourceScheduleId?: string | null };

function isRecurringJob(job: RebootHistoryItem): boolean {
  return job.fromSchedule === true || Boolean(job.sourceScheduleId);
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function normalizeLocalTime(value: string): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(value.trim());
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

function sameWeekdays(a: number[] | null, b: number[] | null): boolean {
  const left = [...(a ?? [])].sort((x, y) => x - y);
  const right = [...(b ?? [])].sort((x, y) => x - y);
  if (left.length !== right.length) return false;
  return left.every((day, index) => day === right[index]);
}

function previewNextIso(input: {
  cadence: RebootCadence;
  weekdays: number[] | null;
  localTime: string;
  timezone: string;
}): string | null {
  try {
    return nextRebootOccurrence({
      cadence: input.cadence,
      weekdays: input.cadence === "weekly" ? input.weekdays : null,
      localTime: input.localTime,
      timezone: input.timezone,
    }).toISOString();
  } catch {
    return null;
  }
}

export function UpdatesPanel({
  patches: patchesProp,
  assetTag,
  canInstall = false,
  patchJobs: patchJobsProp = [],
  checkJobs: checkJobsProp = [],
  rebootJobs: rebootJobsProp = [],
  schedule: scheduleProp = null,
}: {
  patches: ComputerPatches | null;
  assetTag: string;
  canInstall?: boolean;
  patchJobs?: PatchInstallListItem[];
  checkJobs?: MissingCheckListItem[];
  rebootJobs?: RebootHistoryItem[];
  schedule?: ScheduleListItem | null;
}) {
  const [patches, setPatches] = React.useState(patchesProp);
  const [patchJobs, setPatchJobs] = React.useState(patchJobsProp);
  const [checkJobs, setCheckJobs] = React.useState(checkJobsProp);
  const [rebootJobs, setRebootJobs] = React.useState(rebootJobsProp);
  const [schedule, setSchedule] = React.useState<ScheduleListItem | null>(
    scheduleProp ?? null,
  );
  const [cadence, setCadence] = React.useState<RebootCadence>(
    scheduleProp?.cadence ?? "daily",
  );
  const [weekdays, setWeekdays] = React.useState<number[]>(
    scheduleProp?.weekdays ?? [],
  );
  const [localTime, setLocalTime] = React.useState(scheduleProp?.localTime ?? "");
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

  React.useEffect(() => {
    setSchedule(scheduleProp ?? null);
    if (!scheduleProp) return;
    setCadence(scheduleProp.cadence);
    setWeekdays(scheduleProp.weekdays ?? []);
    setLocalTime(scheduleProp.localTime);
  }, [scheduleProp]);

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

  const normalizedTime = normalizeLocalTime(localTime);
  const formWeekdays = cadence === "weekly" ? weekdays : null;
  const browserTz = browserTimeZone();
  const formMatchesSchedule =
    !!schedule &&
    schedule.cadence === cadence &&
    normalizeLocalTime(schedule.localTime) === normalizedTime &&
    sameWeekdays(schedule.weekdays, formWeekdays);
  const liveNextIso =
    normalizedTime && (cadence === "daily" || weekdays.length > 0)
      ? previewNextIso({
          cadence,
          weekdays: formWeekdays,
          localTime: normalizedTime,
          timezone: browserTz,
        })
      : null;
  const nextIso =
    formMatchesSchedule && schedule && !schedule.enabled
      ? null
      : formMatchesSchedule && schedule?.nextRunAtIso
        ? schedule.nextRunAtIso
        : liveNextIso;
  const canSaveSchedule =
    !!normalizedTime && (cadence === "daily" || weekdays.length > 0) && !busy;

  function toggleWeekday(iso: number) {
    setWeekdays((prev) => {
      const next = prev.includes(iso)
        ? prev.filter((day) => day !== iso)
        : [...prev, iso];
      return next.sort((a, b) => a - b);
    });
  }

  function applySavedSchedule(next: ScheduleListItem) {
    setSchedule(next);
    setCadence(next.cadence);
    setWeekdays(next.weekdays ?? []);
    setLocalTime(next.localTime);
  }

  function doSaveSchedule() {
    if (!normalizedTime) return;
    if (cadence === "weekly" && weekdays.length === 0) return;
    const timezone = browserTz;
    startBusy(async () => {
      const res = await upsertRebootScheduleAction({
        assetTag,
        cadence,
        weekdays: cadence === "weekly" ? weekdays : undefined,
        localTime: normalizedTime,
        timezone,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.schedule) {
        applySavedSchedule(res.schedule);
      } else {
        setSchedule({
          id: res.id,
          assetId: schedule?.assetId ?? "",
          cadence,
          weekdays: cadence === "weekly" ? weekdays : null,
          localTime: normalizedTime,
          timezone,
          enabled: true,
          requestedBy: schedule?.requestedBy ?? "",
          nextJobId: null,
          nextRunAtIso: previewNextIso({
            cadence,
            weekdays: cadence === "weekly" ? weekdays : null,
            localTime: normalizedTime,
            timezone,
          }),
        });
      }
      toast.success("Recurring reboot saved");
      await refreshSnapshot();
    });
  }

  function doToggleSchedule() {
    if (!schedule) return;
    const enabled = !schedule.enabled;
    startBusy(async () => {
      const res = await setRebootScheduleEnabledAction({ assetTag, enabled });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      let nextRunAtIso: string | null = null;
      if (enabled) {
        nextRunAtIso = previewNextIso({
          cadence: schedule.cadence,
          weekdays: schedule.weekdays,
          localTime: schedule.localTime,
          timezone: schedule.timezone,
        });
      }
      setSchedule({
        ...schedule,
        enabled,
        nextRunAtIso,
        nextJobId: enabled ? schedule.nextJobId : null,
      });
      toast.success(enabled ? "Recurring reboot enabled" : "Recurring reboot disabled");
      await refreshSnapshot();
    });
  }

  function doDeleteSchedule() {
    startBusy(async () => {
      const res = await deleteRebootScheduleAction({ assetTag });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSchedule(null);
      toast.success("Recurring reboot deleted");
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

      {canInstall && (
        <Panel icon={<Power />} title="Recurring reboot">
          <p className="mb-3 text-sm text-muted-foreground">
            Repeat a forced reboot daily or on selected weekdays. The collector
            restarts the computer over WinRM and skips any window it misses.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                Cadence
              </span>
              <select
                aria-label="Cadence"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={cadence}
                disabled={busy}
                onChange={(e) =>
                  setCadence(e.target.value === "weekly" ? "weekly" : "daily")
                }
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                Local time
              </span>
              <input
                type="time"
                aria-label="Reboot time"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={localTime}
                disabled={busy}
                onChange={(e) => setLocalTime(e.target.value)}
              />
            </label>
          </div>
          {cadence === "weekly" && (
            <div className="mt-3 flex flex-wrap gap-3">
              {WEEKDAYS.map((day) => (
                <label
                  key={day.iso}
                  className="flex items-center gap-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={weekdays.includes(day.iso)}
                    disabled={busy}
                    onChange={() => toggleWeekday(day.iso)}
                  />
                  {day.label}
                </label>
              ))}
            </div>
          )}
          {schedule ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {schedule.enabled ? "Enabled" : "Disabled"} · {schedule.timezone}
            </p>
          ) : null}
          {nextIso ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Next:{" "}
              <span className="font-medium text-foreground">
                {fmtDateTime(nextIso)}
              </span>
            </p>
          ) : cadence === "weekly" && weekdays.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Select at least one weekday.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button disabled={!canSaveSchedule} onClick={doSaveSchedule}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Power className="size-4" />
              )}
              Save schedule
            </Button>
            {schedule ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={doToggleSchedule}
              >
                {schedule.enabled ? "Disable" : "Enable"}
              </Button>
            ) : null}
            {schedule ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={doDeleteSchedule}
              >
                Delete
              </Button>
            ) : null}
          </div>
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
                  {isRecurringJob(j) ? (
                    <span className="text-muted-foreground"> · recurring</span>
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
