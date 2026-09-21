"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Loader2,
  Lock,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

import {
  resetColumnConfig,
  saveColumnConfig,
} from "@/app/(app)/columns-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  COLUMN_LABELS,
  catalogFor,
  isLockedColumn,
  type ColumnId,
  type ColumnView,
} from "@/lib/table-columns";
import { cn } from "@/lib/utils";

type Item = { id: ColumnId; visible: boolean };

/** Build the picker's initial rows: the currently visible columns in their
   order, then the remaining catalog columns (available to add), hidden. */
function buildItems(view: ColumnView, current: ColumnId[]): Item[] {
  const catalog = catalogFor(view);
  const visible = current.filter((id) => catalog.includes(id));
  const hidden = catalog.filter((id) => !visible.includes(id));
  return [
    ...visible.map((id) => ({ id, visible: true })),
    ...hidden.map((id) => ({ id, visible: false })),
  ];
}

/**
 * The "Columns" picker (spec 11, AC-4/AC-5). Admins toggle each column on or off
 * and reorder them, then Save (writes the shared layout for everyone) or Reset
 * (deletes the saved row, back to code defaults). Asset Name and Actions are
 * locked: always shown, never removable.
 */
export function ColumnPickerDialog({
  open,
  onOpenChange,
  view,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ColumnView;
  /** The currently resolved, ordered visible column ids (incl. the locked ones). */
  current: ColumnId[];
}) {
  const [items, setItems] = React.useState<Item[]>(() =>
    buildItems(view, current),
  );
  const [isPending, startTransition] = React.useTransition();

  // Reset the working copy each time the dialog opens, so it reflects the latest
  // saved layout and discards any unsaved fiddling from a previous open.
  React.useEffect(() => {
    if (open) setItems(buildItems(view, current));
    // `current` is derived from the saved layout; re-seed when it or the view changes.
  }, [open, view, current]);

  function toggle(id: ColumnId) {
    if (isLockedColumn(id)) return;
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, visible: !it.visible } : it)),
    );
  }

  function move(index: number, dir: -1 | 1) {
    const next = index + dir;
    setItems((prev) => {
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  }

  function onSave() {
    const ids = items.filter((it) => it.visible).map((it) => it.id);
    startTransition(async () => {
      const res = await saveColumnConfig(view, ids);
      if (res.ok) {
        toast.success(res.message);
        onOpenChange(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  function onReset() {
    startTransition(async () => {
      const res = await resetColumnConfig(view);
      if (res.ok) {
        toast.success(res.message);
        onOpenChange(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure columns</DialogTitle>
          <DialogDescription>
            Choose which columns this table shows and in what order. Saved for
            everyone; Asset Name and Actions are always shown.
          </DialogDescription>
        </DialogHeader>

        <ul className="-mx-1 flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto">
          {items.map((it, i) => {
            const locked = isLockedColumn(it.id);
            return (
              <li
                key={it.id}
                className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-accent/50"
              >
                <button
                  type="button"
                  onClick={() => toggle(it.id)}
                  disabled={locked}
                  aria-pressed={it.visible}
                  aria-label={`${it.visible ? "Hide" : "Show"} ${COLUMN_LABELS[it.id]}`}
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded border transition-colors",
                    it.visible
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background text-transparent",
                    locked ? "opacity-70" : "hover:border-primary",
                  )}
                >
                  <Check className="size-3.5" />
                </button>

                <span className="flex-1 text-sm">
                  {COLUMN_LABELS[it.id]}
                </span>

                {locked ? (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                    title="Always shown"
                  >
                    <Lock className="size-3" /> Locked
                  </span>
                ) : (
                  <span className="flex items-center gap-0.5 text-muted-foreground">
                    <GripVertical className="size-4 opacity-40" aria-hidden />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move ${COLUMN_LABELS[it.id]} up`}
                    >
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => move(i, 1)}
                      disabled={i === items.length - 1}
                      aria-label={`Move ${COLUMN_LABELS[it.id]} down`}
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            onClick={onReset}
            disabled={isPending}
            className="sm:mr-auto"
          >
            <RotateCcw className="size-4" /> Reset to defaults
          </Button>
          <Button onClick={onSave} disabled={isPending}>
            {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save for everyone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
