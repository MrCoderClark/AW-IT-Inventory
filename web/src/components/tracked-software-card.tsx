"use client";

import * as React from "react";
import { Loader2, Package, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  addTrackedSoftwareAction,
  removeTrackedSoftwareAction,
} from "@/app/(app)/software-actions";
import { SoftwareIconUpload } from "@/components/software-icon-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TrackedSoftwareItem } from "@/lib/data";

/**
 * The tracked-software watchlist manager on the Admin page (spec 15, AC-1). Only
 * rendered for a `scan:write` admin — a user without it never sees these controls
 * (AC-7), and each action re-checks the permission server-side. Add a title with
 * the form; remove one with its trash button. The list is passed from the server;
 * a mutation revalidates `/admin`, so the next load reflects the change.
 */
export function TrackedSoftwareCard({
  titles,
}: {
  titles: TrackedSoftwareItem[];
}) {
  const [name, setName] = React.useState("");
  const [isAdding, startAdd] = React.useTransition();
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  const [isRemoving, startRemove] = React.useTransition();

  function add(e: React.FormEvent) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    startAdd(async () => {
      const res = await addTrackedSoftwareAction(value);
      if (res.ok) {
        toast.success(res.message);
        setName("");
      } else {
        toast.error(res.error);
      }
    });
  }

  function remove(id: string) {
    setRemovingId(id);
    startRemove(async () => {
      const res = await removeTrackedSoftwareAction(id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
      setRemovingId(null);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={add} className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add a title, e.g. Google Chrome"
          aria-label="Software title to track"
          disabled={isAdding}
          maxLength={200}
        />
        <Button type="submit" disabled={isAdding || !name.trim()}>
          {isAdding ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Add
        </Button>
      </form>

      {titles.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {titles.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-3 py-2">
              {t.iconUrl ? (
                <img
                  src={t.iconUrl}
                  alt=""
                  aria-hidden
                  className="size-7 shrink-0 rounded-md object-contain"
                />
              ) : (
                <span
                  aria-hidden
                  className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-primary [&_svg]:size-4"
                >
                  <Package />
                </span>
              )}
              <span className="flex-1 truncate text-sm font-medium">{t.name}</span>
              <SoftwareIconUpload
                id={t.id}
                name={t.name}
                hasCustomIcon={t.hasCustomIcon}
              />
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => remove(t.id)}
                disabled={isRemoving && removingId === t.id}
                aria-label={`Stop tracking ${t.name}`}
              >
                {isRemoving && removingId === t.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No titles tracked yet. Add one above to start watching for it across the
          fleet.
        </p>
      )}
    </div>
  );
}
