"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  deleteScriptScheduleAction,
  saveScriptScheduleAction,
  setScriptScheduleEnabledAction,
} from "@/app/(app)/script-actions";
import { fmtDateTime } from "@/components/detail-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SavedScriptSchedule } from "@/db/script-schedules";
import type { ScriptListItem } from "@/db/scripts";
import type { LocationOption } from "@/lib/data";
import {
  describeSchedule,
  WEEKDAYS,
  type ScriptCadence,
} from "@/lib/script-schedule";

type ComputerOpt = { tag: string; name: string };

export function ScriptSchedulesPanel({
  schedules,
  scripts,
  computers,
  locations,
}: {
  schedules: SavedScriptSchedule[];
  scripts: ScriptListItem[];
  computers: ComputerOpt[];
  locations: LocationOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, startBusy] = React.useTransition();

  const [scriptId, setScriptId] = React.useState(scripts[0]?.id ?? "");
  const [mode, setMode] = React.useState<"tags" | "location">("tags");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [locationId, setLocationId] = React.useState("");
  const [cadence, setCadence] = React.useState<ScriptCadence>("daily");
  const [hour, setHour] = React.useState(9);
  const [minute, setMinute] = React.useState(0);
  const [weekday, setWeekday] = React.useState(1);

  function openCreate() {
    setScriptId(scripts[0]?.id ?? "");
    setMode("tags");
    setSelected(new Set());
    setLocationId("");
    setCadence("daily");
    setHour(9);
    setMinute(0);
    setWeekday(1);
    setOpen(true);
  }

  function toggle(tag: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function save() {
    startBusy(async () => {
      const targetSpec =
        mode === "tags"
          ? { mode: "tags" as const, tags: Array.from(selected) }
          : { mode: "location" as const, locationId };

      const res = await saveScriptScheduleAction({
        scriptId,
        targetSpec,
        schedule: {
          cadence,
          hour,
          minute,
          weekday: cadence === "weekly" ? weekday : null,
        },
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Schedule saved");
      setOpen(false);
      router.refresh();
    });
  }

  function remove(id: string) {
    startBusy(async () => {
      const res = await deleteScriptScheduleAction(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Schedule deleted");
      router.refresh();
    });
  }

  function toggleEnabled(id: string, enabled: boolean) {
    startBusy(async () => {
      const res = await setScriptScheduleEnabledAction(id, enabled);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.refresh();
    });
  }

  function targetLabel(s: SavedScriptSchedule): string {
    if (s.targetSpec.mode === "tags") {
      const n = s.targetSpec.tags.length;
      return n === 1 ? s.targetSpec.tags[0] : `${n} computers`;
    }
    const loc = locations.find((l) => l.id === s.targetSpec.locationId);
    return loc?.path ?? "Location";
  }

  const canSave =
    Boolean(scriptId) &&
    (mode === "tags" ? selected.size > 0 : Boolean(locationId.trim()));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Schedules</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={openCreate}
          disabled={scripts.length === 0}
        >
          <Plus className="size-4" /> New schedule
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Script</th>
              <th className="px-3 py-2 font-medium">Targets</th>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Next</th>
              <th className="px-3 py-2 font-medium">On</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {schedules.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No schedules. Add one to run a script on a cadence.
                </td>
              </tr>
            ) : (
              schedules.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2 font-medium">{s.scriptName}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {targetLabel(s)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {describeSchedule(s)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {fmtDateTime(s.nextRunAt)}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={busy}
                      onChange={(e) => toggleEnabled(s.id, e.target.checked)}
                      aria-label={`Enable ${s.scriptName} schedule`}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => remove(s.id)}
                      aria-label="Delete schedule"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New schedule</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Script</span>
              <select
                className="rounded-md border bg-background px-2 py-1.5"
                value={scriptId}
                onChange={(e) => setScriptId(e.target.value)}
              >
                {scripts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex gap-2">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === "tags"}
                  onChange={() => setMode("tags")}
                />
                Computers
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === "location"}
                  onChange={() => setMode("location")}
                />
                Location
              </label>
            </div>

            {mode === "tags" ? (
              <div className="max-h-40 overflow-y-auto rounded-md border">
                <ul className="divide-y">
                  {computers.map((c) => (
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
              </div>
            ) : (
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
            )}

            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Cadence</span>
                <select
                  className="rounded-md border bg-background px-2 py-1.5"
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as ScriptCadence)}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
              {cadence === "weekly" && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Weekday</span>
                  <select
                    className="rounded-md border bg-background px-2 py-1.5"
                    value={weekday}
                    onChange={(e) => setWeekday(Number(e.target.value))}
                  >
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Hour</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  className="w-20 rounded-md border bg-background px-2 py-1.5"
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Minute</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  className="w-20 rounded-md border bg-background px-2 py-1.5"
                  value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))}
                />
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !canSave} onClick={save}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
