"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { deleteReportAction } from "@/app/(app)/reports/report-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { REPORT_SOURCES } from "@/lib/report-sources";

export interface CustomReportCard {
  id: string;
  name: string;
  description: string | null;
  source: string;
  updatedAt: string;
  /** Folder/category, or null for uncategorized (spec 26 phase 2 extra). */
  category?: string | null;
  /** A delivery-schedule summary (spec 26 phase 2), or null when unscheduled. */
  schedule?: { label: string; enabled: boolean } | null;
}

const UNCATEGORIZED = "Uncategorized";

/** Group reports by folder, real folders first (alpha), uncategorized last. */
function groupByCategory(
  reports: CustomReportCard[],
): { name: string; reports: CustomReportCard[] }[] {
  const groups = new Map<string, CustomReportCard[]>();
  for (const r of reports) {
    const key = r.category?.trim() || UNCATEGORIZED;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    })
    .map(([name, reports]) => ({ name, reports }));
}

/**
 * The saved custom reports grid on the `/reports` hub (spec 26, slice 1d).
 * Everyone with `report:read` can open a saved report; editing + deleting need
 * `report:write` (the controls are hidden without it and the action rechecks).
 */
export function CustomReportsList({
  reports,
  canWrite,
}: {
  reports: CustomReportCard[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [toDelete, setToDelete] = React.useState<CustomReportCard | null>(null);
  const [deleting, startDelete] = React.useTransition();

  function confirmDelete() {
    if (!toDelete) return;
    const target = toDelete;
    startDelete(async () => {
      const res = await deleteReportAction(target.id);
      if (res.ok) {
        toast.success(res.message);
        setToDelete(null);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function renderCard(r: CustomReportCard) {
    const sourceLabel = REPORT_SOURCES[r.source]?.label ?? r.source;
    return (
      <Card key={r.id} className="gap-0 p-0">
        <div className="flex items-start justify-between gap-2 p-4">
          <Link href={`/reports/custom/${r.id}`} className="min-w-0 flex-1">
            <h3 className="truncate font-heading text-base font-semibold hover:underline">
              {r.name}
            </h3>
            <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
              {r.description || "No description."}
            </p>
          </Link>
          {canWrite && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label={`Actions for ${r.name}`}
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  render={<Link href={`/reports/builder?id=${r.id}`} />}
                >
                  <Pencil className="size-4 text-muted-foreground" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setToDelete(r)}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{sourceLabel}</Badge>
            {r.schedule && (
              <Badge
                variant="outline"
                className="gap-1 text-muted-foreground"
                title={r.schedule.label}
              >
                <CalendarClock className="size-3" />
                {r.schedule.enabled ? "Scheduled" : "Paused"}
              </Badge>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            Updated {formatDate(r.updatedAt)}
          </span>
        </div>
      </Card>
    );
  }

  if (reports.length === 0) {
    return (
      <Card className="items-center gap-3 p-10 text-center">
        <Wand2 className="size-8 text-muted-foreground" />
        <div>
          <h3 className="font-heading text-base font-semibold">
            No saved reports yet
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Build a custom report — pick a data source, choose columns, filter
            and group — then save it here to re-run any time.
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/reports/builder" />}>
          <Plus /> New custom report
        </Button>
      </Card>
    );
  }

  const groups = groupByCategory(reports);
  const showHeadings = groups.length > 1;

  return (
    <>
      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <section key={group.name} className="flex flex-col gap-3">
            {showHeadings && (
              <h2 className="flex items-center gap-2 font-heading text-sm font-semibold text-muted-foreground">
                <FolderOpen className="size-4" />
                {group.name}
                <span className="font-normal">({group.reports.length})</span>
              </h2>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {group.reports.map((r) => renderCard(r))}
            </div>
          </section>
        ))}
      </div>

      <Dialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete report?</DialogTitle>
            <DialogDescription>
              Delete “{toDelete?.name}” for everyone? This removes the saved
              definition; the underlying data is untouched. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setToDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}
