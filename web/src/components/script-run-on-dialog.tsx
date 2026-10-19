"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { runScriptBatchAction } from "@/app/(app)/script-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LocationOption } from "@/lib/data";
import type { ScriptListItem } from "@/db/scripts";

type ComputerOpt = { tag: string; name: string };

export function ScriptRunOnDialog({
  script,
  computers,
  locations,
  open,
  onOpenChange,
}: {
  script: ScriptListItem | null;
  computers: ComputerOpt[];
  locations: LocationOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [mode, setMode] = React.useState<"tags" | "location">("tags");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [locationId, setLocationId] = React.useState("");
  const [filter, setFilter] = React.useState("");
  const [busy, startBusy] = React.useTransition();

  React.useEffect(() => {
    if (open) {
      setMode("tags");
      setSelected(new Set());
      setLocationId("");
      setFilter("");
    }
  }, [open, script?.id]);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return computers;
    return computers.filter(
      (c) =>
        c.tag.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
  }, [computers, filter]);

  function toggle(tag: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function run() {
    if (!script) return;
    startBusy(async () => {
      const targetSpec =
        mode === "tags"
          ? { mode: "tags" as const, tags: Array.from(selected) }
          : { mode: "location" as const, locationId };

      const res = await runScriptBatchAction({
        scriptId: script.id,
        targetSpec,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const parts = [`Enqueued ${res.enqueued}`];
      if (res.skippedNoIp) parts.push(`${res.skippedNoIp} no IP`);
      if (res.skippedInflight) parts.push(`${res.skippedInflight} in-flight`);
      toast.success(parts.join(" · "));
      onOpenChange(false);
      router.refresh();
    });
  }

  const canRun =
    mode === "tags" ? selected.size > 0 : Boolean(locationId.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Run on…{script ? ` — ${script.name}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="target-mode"
              checked={mode === "tags"}
              onChange={() => setMode("tags")}
            />
            Computers
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="target-mode"
              checked={mode === "location"}
              onChange={() => setMode("location")}
            />
            Location
          </label>
        </div>

        {mode === "tags" ? (
          <div className="flex flex-col gap-2">
            <input
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              placeholder="Filter computers…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="max-h-56 overflow-y-auto rounded-md border">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                  No computers with an IP.
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {filtered.map((c) => (
                    <li key={c.tag}>
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-muted/40">
                        <input
                          type="checkbox"
                          checked={selected.has(c.tag)}
                          onChange={() => toggle(c.tag)}
                        />
                        <span className="font-medium">{c.tag}</span>
                        <span className="truncate text-muted-foreground">
                          {c.name}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {selected.size} selected
            </p>
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">
              Location subtree (includes children)
            </span>
            <select
              className="rounded-md border bg-background px-2 py-1.5"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">Pick a location…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {"\u00A0".repeat(l.depth * 2)}
                  {l.path}
                </option>
              ))}
            </select>
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !canRun} onClick={run}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
