"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Rocket } from "lucide-react";
import { toast } from "sonner";

import {
  cancelDeploymentAction,
  deploySoftwareAction,
} from "@/app/(app)/software-deploy-actions";
import { Panel } from "@/components/detail-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type DeployPackageOption = {
  id: string;
  name: string;
  version: string;
  stepCount: number;
};

export type DeployStepResult = {
  name: string;
  status: "ok" | "failed" | "skipped";
  exitCode: number | null;
};

export type DeployHistoryItem = {
  id: string;
  packageName: string;
  packageVersion: string;
  stepCount: number;
  status: "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled";
  requestedBy: string;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
  waitingForCollector: boolean;
  steps: DeployStepResult[] | null;
};

const ACTIVE = new Set(["pending", "claimed", "running"]);

function statusBadge(item: DeployHistoryItem) {
  const { status, waitingForCollector } = item;
  if (status === "pending")
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="size-3 animate-spin" />
        {waitingForCollector ? "Waiting for collector" : "Queued"}
      </Badge>
    );
  if (status === "claimed" || status === "running")
    return (
      <Badge className="gap-1">
        <Loader2 className="size-3 animate-spin" /> Running
      </Badge>
    );
  if (status === "succeeded")
    return <Badge className="bg-emerald-600 text-white">Succeeded</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="outline">Canceled</Badge>;
}

/**
 * Deploy a library package to this computer and show its deployment history
 * (spec 23). Only rendered for a `software:deploy` admin. The server owns the
 * queue; this picks a package, fires the deploy action, and refreshes.
 */
export function SoftwareDeployPanel({
  assetTag,
  packages,
  initialHistory,
}: {
  assetTag: string;
  packages: DeployPackageOption[];
  initialHistory: DeployHistoryItem[];
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [cancelingId, setCancelingId] = React.useState<string | null>(null);

  const hasInFlight = initialHistory.some((d) => ACTIVE.has(d.status));

  // The history is server-rendered; while a deployment is in flight, re-fetch it so
  // the worker's status changes (running → succeeded/failed) show without a manual
  // reload. Stops once nothing is active.
  React.useEffect(() => {
    if (!hasInFlight) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [hasInFlight, router]);

  async function deploy() {
    if (!selected) return toast.error("Choose a package.");
    setBusy(true);
    try {
      const res = await deploySoftwareAction(assetTag, selected);
      if (res.ok) {
        toast.success(res.message);
        setSelected("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setCancelingId(id);
    try {
      const res = await cancelDeploymentAction(id, assetTag);
      if (res.ok) {
        toast.success(res.message);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setCancelingId(null);
    }
  }

  return (
    <Panel icon={<Rocket />} title="Deploy software">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || packages.length === 0}
            className="h-9 min-w-56 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <option value="">
              {packages.length === 0 ? "No packages in the library" : "Choose a package…"}
            </option>
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.version} · {p.stepCount} step{p.stepCount === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <Button onClick={deploy} disabled={busy || !selected || hasInFlight}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
            Deploy
          </Button>
        </div>
        {hasInFlight && (
          <p className="text-xs text-muted-foreground">
            A deployment is already in progress on this computer. Wait for it to
            finish (or cancel it) before starting another.
          </p>
        )}

        {initialHistory.length > 0 && (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {initialHistory.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <div className="font-medium">
                        {d.packageName}{" "}
                        <span className="font-normal text-muted-foreground">
                          {d.packageVersion}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {d.stepCount} step{d.stepCount === 1 ? "" : "s"}
                      </div>
                      {d.status === "failed" && d.error && (
                        <div className="mt-0.5 max-w-sm truncate text-xs text-red-600" title={d.error}>
                          {d.error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{statusBadge(d)}</TableCell>
                    <TableCell className="text-muted-foreground">{d.requestedBy}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(d.requestedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {ACTIVE.has(d.status) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => cancel(d.id)}
                          disabled={cancelingId === d.id}
                        >
                          {cancelingId === d.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            "Cancel"
                          )}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Panel>
  );
}
