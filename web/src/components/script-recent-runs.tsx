"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { fmtDateTime } from "@/components/detail-ui";
import { ScriptRunOutput } from "@/components/script-run-output";
import type { ScriptRunFleetItem } from "@/db/script-runs";

const STATUS: Record<string, string> = {
  pending: "Queued",
  claimed: "Running…",
  running: "Running…",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

export function ScriptRecentRuns({
  initial,
}: {
  initial: ScriptRunFleetItem[];
}) {
  const router = useRouter();
  const rows = initial;
  const inflight = rows.some(
    (j) =>
      j.status === "pending" || j.status === "claimed" || j.status === "running",
  );

  React.useEffect(() => {
    if (!inflight) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [inflight, router]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Recent runs</h2>
        {inflight && (
          <span className="text-xs text-muted-foreground">Updating…</span>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No runs yet. Use Run on… or open a computer’s Scripts panel.
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((j) => (
              <li key={j.id} className="px-3 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="font-medium">{j.scriptName}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {STATUS[j.status] ?? j.status}
                    </span>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      <Link
                        href={`/assets/${j.assetTag}`}
                        className="hover:underline"
                      >
                        {j.assetTag}
                      </Link>
                      {j.assetName ? ` · ${j.assetName}` : ""}
                      {" · "}
                      {fmtDateTime(j.requestedAt)} · {j.requestedBy}
                      {j.waitingForCollector ? " · waiting for collector" : ""}
                    </div>
                  </div>
                </div>
                {(j.status === "succeeded" ||
                  j.status === "failed" ||
                  j.status === "canceled") && (
                  <ScriptRunOutput result={j.result} error={j.error} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
