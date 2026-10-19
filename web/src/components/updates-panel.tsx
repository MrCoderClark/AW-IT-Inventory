import { ArrowRight, Package, RefreshCw, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Dot, Panel, fmtDate, fmtDateTime } from "@/components/detail-ui";
import type { ComputerPatches } from "@/db/patches";

/**
 * Per-computer Updates tab (spec 31, AC-3): pending reboot, last-update age,
 * installed KBs, and available winget upgrades. Pure render over stored state.
 */

function lastUpdateLabel(days: number | null | undefined): string {
  if (days == null) return "—";
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

export function UpdatesPanel({ patches }: { patches: ComputerPatches | null }) {
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
          <span className="text-sm text-muted-foreground">
            Last successful update:{" "}
            <span className="font-medium text-foreground">
              {lastUpdateLabel(patches.updatesLastDays)}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            Collected {fmtDateTime(patches.collectedAt)}
          </span>
        </div>

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
    </div>
  );
}
