"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Package, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import {
  requestCancelPatchInstall,
  requestMissingUpdateCheck,
  requestPatchInstall,
} from "@/app/(app)/patch-install-actions";
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

/**
 * Per-computer Updates tab (spec 31): inventory + Missing + optional Install
 * selected (phase 3, AC-18) for `software:deploy` admins.
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

export function UpdatesPanel({
  patches,
  assetTag,
  canInstall = false,
  patchJobs = [],
  checkJobs = [],
}: {
  patches: ComputerPatches | null;
  assetTag: string;
  canInstall?: boolean;
  patchJobs?: PatchInstallListItem[];
  checkJobs?: MissingCheckListItem[];
}) {
  const router = useRouter();
  const [osSel, setOsSel] = React.useState<Set<string>>(new Set());
  const [appSel, setAppSel] = React.useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [busy, startBusy] = React.useTransition();

  const inflight = patchJobs.some(
    (j) =>
      j.status === "pending" || j.status === "claimed" || j.status === "running",
  );
  const checkInflight = checkJobs.some(
    (j) =>
      j.status === "pending" || j.status === "claimed" || j.status === "running",
  );

  if (!patches) {
    return (
      <Panel icon={<RefreshCw />} title="Updates">
        <p className="text-sm text-muted-foreground">
          No patch inventory yet. Scan this computer to collect installed KBs,
          pending reboot, and available app upgrades.
        </p>
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

  function doInstall() {
    startBusy(async () => {
      const res = await requestPatchInstall({
        assetTag,
        osKbIds: [...osSel],
        packageIds: [...appSel],
      });
      setConfirmOpen(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Patch install queued");
      setOsSel(new Set());
      setAppSel(new Set());
      router.refresh();
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
      router.refresh();
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
      router.refresh();
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
          <div className="mb-4">
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

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install selected updates?</DialogTitle>
            <DialogDescription>
              {osSel.size} OS update{osSel.size === 1 ? "" : "s"} and {appSel.size}{" "}
              app upgrade{appSel.size === 1 ? "" : "s"} will be installed over
              WinRM. The host will <strong>not</strong> be rebooted
              automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={doInstall}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
