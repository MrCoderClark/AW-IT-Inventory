"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Undo2 } from "lucide-react";
import { toast } from "sonner";

import {
  assignAssetAction,
  returnAssetAction,
} from "@/app/(app)/people-actions";
import type { PersonOption } from "@/components/asset-form-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Assign / return a device to a person (spec 16, AC-5/AC-6), shared by the tabbed
 * detail pages (computers + thin categories). Routes through the assignment engine
 * server actions and refreshes to show the updated history. `asset:write` only — the
 * caller decides whether to render it.
 */
export function AssignmentControls({
  assetId,
  hasAssignee,
  people,
}: {
  assetId: string;
  hasAssignee: boolean;
  people: PersonOption[];
}) {
  const router = useRouter();
  const [isBusy, start] = React.useTransition();
  const [person, setPerson] = React.useState("");

  function assign() {
    if (!person) return;
    start(async () => {
      const res = await assignAssetAction(assetId, person);
      if (res.ok) {
        toast.success(res.message);
        setPerson("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function returnDevice() {
    start(async () => {
      const res = await returnAssetAction(assetId);
      if (res.ok) {
        toast.success(res.message);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={person || null} onValueChange={(v) => setPerson(v ?? "")}>
        <SelectTrigger className="w-full sm:w-64">
          <SelectValue placeholder={hasAssignee ? "Reassign to…" : "Assign to…"}>
            {(value) =>
              people.find((p) => p.id === value)?.name ??
              (hasAssignee ? "Reassign to…" : "Assign to…")
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {people.length ? (
            people.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))
          ) : (
            <SelectItem value="" disabled>
              No active people — add someone first
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      <Button onClick={assign} disabled={isBusy || !person}>
        {isBusy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        Assign
      </Button>
      {hasAssignee && (
        <Button variant="outline" onClick={returnDevice} disabled={isBusy}>
          <Undo2 className="size-4" /> Return
        </Button>
      )}
    </div>
  );
}
