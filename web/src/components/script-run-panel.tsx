"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, TerminalSquare } from "lucide-react";
import { toast } from "sonner";

import {
  cancelScriptRunAction,
  runScriptAction,
} from "@/app/(app)/script-actions";
import { fmtDateTime, Panel } from "@/components/detail-ui";
import { Button } from "@/components/ui/button";
import type { ScriptRunListItem } from "@/db/script-runs";

export type ScriptOption = { id: string; name: string; timeoutSeconds: number };

const STATUS: Record<string, string> = {
  pending: "Queued",
  claimed: "Running…",
  running: "Running…",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

export function ScriptRunPanel({
  assetTag,
  scripts,
  initialHistory,
  hasIp,
}: {
  assetTag: string;
  scripts: ScriptOption[];
  initialHistory: ScriptRunListItem[];
  hasIp: boolean;
}) {
  const router = useRouter();
  const [scriptId, setScriptId] = React.useState(scripts[0]?.id ?? "");
  const [busy, startBusy] = React.useTransition();
  const history = initialHistory;

  const inflight = history.some(
    (j) =>
      j.status === "pending" || j.status === "claimed" || j.status === "running",
  );

  function run() {
    if (!scriptId) return;
    startBusy(async () => {
      const res = await runScriptAction(assetTag, scriptId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Script queued");
      router.refresh();
    });
  }

  function cancel(jobId: string) {
    startBusy(async () => {
      const res = await cancelScriptRunAction(jobId, assetTag);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Canceled");
      router.refresh();
    });
  }

  return (
    <Panel icon={<TerminalSquare />} title="Scripts">
      {!hasIp ? (
        <p className="text-sm text-muted-foreground">
          Add an IP address to this computer before running scripts.
        </p>
      ) : scripts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No scripts in the library yet. Create one under Manage → Scripts.
        </p>
      ) : (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <select
            className="h-9 min-w-[200px] flex-1 rounded-lg border border-input bg-transparent px-2 text-sm"
            value={scriptId}
            onChange={(e) => setScriptId(e.target.value)}
            disabled={busy || inflight}
          >
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button disabled={!scriptId || inflight || busy} onClick={run}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <TerminalSquare className="size-4" />
            )}
            Run
          </Button>
        </div>
      )}

      {history.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {history.map((j) => (
            <li key={j.id} className="px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{j.scriptName}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {STATUS[j.status] ?? j.status}
                    {j.result?.exitCode != null
                      ? ` · exit ${j.result.exitCode}`
                      : ""}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {fmtDateTime(j.requestedAt)} · {j.requestedBy}
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
                    onClick={() => cancel(j.id)}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              {j.result?.outputTail ? (
                <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">
                  {j.result.outputTail}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
