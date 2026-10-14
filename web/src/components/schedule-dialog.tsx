"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Clock, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import {
  deleteScheduleAction,
  saveScheduleAction,
} from "@/app/(app)/reports/report-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  computeNextRun,
  describeSchedule,
  WEEKDAYS,
  type Cadence,
  type ScheduleInput,
} from "@/lib/report-schedule";

export interface ScheduleState {
  cadence: Cadence;
  hour: number;
  minute: number;
  weekday: number;
  dayOfMonth: number;
  recipients: string[];
  format: "csv" | "xlsx";
  enabled: boolean;
}

/** The existing schedule shape the page already holds (null when unscheduled). */
export interface InitialSchedule {
  cadence: Cadence;
  hour: number;
  minute: number;
  weekday: number | null;
  dayOfMonth: number | null;
  recipients: string[];
  format: "csv" | "xlsx";
  enabled: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function seed(initial: InitialSchedule | null): ScheduleState {
  return {
    cadence: initial?.cadence ?? "daily",
    hour: initial?.hour ?? 9,
    minute: initial?.minute ?? 0,
    weekday: initial?.weekday ?? 1,
    dayOfMonth: initial?.dayOfMonth ?? 1,
    recipients: initial?.recipients ?? [],
    format: initial?.format ?? "csv",
    enabled: initial?.enabled ?? true,
  };
}

/**
 * Create / edit / remove a saved report's delivery schedule (spec 26, phase 2,
 * slice 2a). Report emailed to the chosen recipients on a cadence. Gated on
 * `report:write` (the server action rechecks); the trigger is only rendered for
 * writers. No email is sent here — this just stores the schedule.
 */
export function ScheduleDialog({
  reportId,
  reportName,
  initial,
}: {
  reportId: string;
  reportName: string;
  initial: InitialSchedule | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [s, setS] = React.useState<ScheduleState>(() => seed(initial));
  const [draft, setDraft] = React.useState("");
  const [saving, startSave] = React.useTransition();
  const [removing, startRemove] = React.useTransition();

  // Re-seed each time the dialog opens so it reflects the latest saved schedule
  // (handled in the open handler, not an effect, to avoid a cascading render).
  function onOpenChange(next: boolean) {
    if (next) {
      setS(seed(initial));
      setDraft("");
    }
    setOpen(next);
  }

  const asInput: ScheduleInput = {
    cadence: s.cadence,
    hour: s.hour,
    minute: s.minute,
    weekday: s.cadence === "weekly" ? s.weekday : null,
    dayOfMonth: s.cadence === "monthly" ? s.dayOfMonth : null,
    recipients: s.recipients,
    format: s.format,
  };

  function addRecipient() {
    const email = draft.trim().toLowerCase();
    if (!email) return;
    setS((prev) =>
      prev.recipients.includes(email)
        ? prev
        : { ...prev, recipients: [...prev.recipients, email] },
    );
    setDraft("");
  }

  function removeRecipient(email: string) {
    setS((prev) => ({
      ...prev,
      recipients: prev.recipients.filter((e) => e !== email),
    }));
  }

  function onSave() {
    startSave(async () => {
      const res = await saveScheduleAction({
        reportId,
        enabled: s.enabled,
        schedule: {
          cadence: asInput.cadence,
          hour: asInput.hour,
          minute: asInput.minute,
          weekday: asInput.weekday,
          dayOfMonth: asInput.dayOfMonth,
          recipients: asInput.recipients,
          format: asInput.format,
        },
      });
      if (res.ok) {
        toast.success(res.message);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function onRemove() {
    startRemove(async () => {
      const res = await deleteScheduleAction(reportId);
      if (res.ok) {
        toast.success(res.message);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const busy = saving || removing;
  const canPreview = s.recipients.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={<Button variant="outline" />}
        aria-label="Schedule delivery"
      >
        <CalendarClock />
        {initial ? "Edit schedule" : "Schedule"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Schedule delivery</DialogTitle>
          <DialogDescription>
            Email “{reportName}” to recipients on a cadence. The report runs live
            each time it’s sent.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Cadence + time */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Cadence
              </span>
              <Select
                value={s.cadence}
                onValueChange={(v) =>
                  v && setS((p) => ({ ...p, cadence: v as Cadence }))
                }
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </label>

            {s.cadence === "weekly" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Day
                </span>
                <Select
                  value={String(s.weekday)}
                  onValueChange={(v) =>
                    v && setS((p) => ({ ...p, weekday: Number(v) }))
                  }
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((d, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}

            {s.cadence === "monthly" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Day of month
                </span>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={s.dayOfMonth}
                  onChange={(e) =>
                    setS((p) => ({
                      ...p,
                      dayOfMonth: Math.max(
                        1,
                        Math.min(31, Number(e.target.value) || 1),
                      ),
                    }))
                  }
                  className="w-24"
                />
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Time
              </span>
              <Input
                type="time"
                value={`${pad2(s.hour)}:${pad2(s.minute)}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map(Number);
                  setS((p) => ({
                    ...p,
                    hour: Number.isFinite(h) ? h : p.hour,
                    minute: Number.isFinite(m) ? m : p.minute,
                  }));
                }}
                className="w-32"
              />
            </label>
          </div>

          {/* Recipients */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Recipients
            </span>
            <div className="flex gap-2">
              <Input
                type="email"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRecipient();
                  }
                }}
                placeholder="name@company.com"
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={addRecipient}
                disabled={!draft.trim()}
              >
                <Plus /> Add
              </Button>
            </div>
            {s.recipients.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {s.recipients.map((email) => (
                  <Badge
                    key={email}
                    variant="secondary"
                    className="gap-1 pr-1 font-normal"
                  >
                    {email}
                    <button
                      type="button"
                      onClick={() => removeRecipient(email)}
                      aria-label={`Remove ${email}`}
                      className="grid size-4 place-items-center rounded-sm hover:bg-foreground/10"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Format + active */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Attachment
              </span>
              <Select
                value={s.format}
                onValueChange={(v) =>
                  v && setS((p) => ({ ...p, format: v as "csv" | "xlsx" }))
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="xlsx">Excel</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={s.enabled}
                onCheckedChange={(next) => setS((p) => ({ ...p, enabled: next }))}
                aria-label="Schedule active"
              />
              <span className="text-muted-foreground">
                {s.enabled ? "Active" : "Paused"}
              </span>
            </label>
          </div>

          {/* Preview */}
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <Clock className="size-4 shrink-0 text-muted-foreground" />
            {canPreview ? (
              <span>
                {describeSchedule(asInput)} ·{" "}
                <span className="text-muted-foreground">
                  next {s.enabled ? formatNext(computeNextRun(asInput)) : "— paused"}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                Add a recipient to schedule delivery.
              </span>
            )}
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {initial ? (
            <Button
              variant="destructive"
              onClick={onRemove}
              disabled={busy}
              className="sm:mr-auto"
            >
              {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Remove schedule
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={onSave} disabled={busy || s.recipients.length === 0}>
            {saving ? <Loader2 className="animate-spin" /> : <CalendarClock />}
            {initial ? "Save schedule" : "Schedule delivery"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatNext(d: Date): string {
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
