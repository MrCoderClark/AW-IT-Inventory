"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArchiveRestore,
  ArchiveX,
  ArrowLeft,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import {
  archivePersonAction,
  assignAssetAction,
  deletePersonAction,
  restorePersonAction,
  returnAssetAction,
} from "@/app/(app)/people-actions";
import { PersonFormDialog } from "@/components/person-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TYPE_ICON,
  type AssignmentEvent,
  type CurrentDevice,
  type DirectoryPerson,
  type LocationOption,
} from "@/lib/data";
import type { AssignableAsset } from "@/db/queries";
import type { PersonFormValues } from "@/lib/person-schema";
import { cn } from "@/lib/utils";

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 truncate text-sm", mono && "font-mono text-[13px]")}>
        {value || "—"}
      </p>
    </div>
  );
}

export function PersonDetail({
  person,
  currentDevices,
  history,
  assignableAssets = [],
  canWrite = false,
  locations = [],
}: {
  person: DirectoryPerson;
  currentDevices: CurrentDevice[];
  history: AssignmentEvent[];
  assignableAssets?: AssignableAsset[];
  canWrite?: boolean;
  locations?: LocationOption[];
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [assignTag, setAssignTag] = React.useState("");
  const [isPending, startTransition] = React.useTransition();

  const archived = person.status === "archived";
  const canDelete = history.length === 0; // no history at all (AC-9)

  // Devices the person doesn't already hold, for the assign picker.
  const heldTags = new Set(currentDevices.map((d) => d.id));
  const pickable = assignableAssets.filter((a) => !heldTags.has(a.tag));

  const formInitial: PersonFormValues = {
    name: person.name,
    email: person.email,
    department: person.department,
    jobTitle: person.jobTitle,
    phone: person.phone,
    employeeId: person.employeeId,
    officeLocationId: person.officeLocationId ?? "",
  };

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) {
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        toast.success(res.message ?? "Done.");
        if (after) after();
        else router.refresh();
      } else {
        toast.error(res.error ?? "Something went wrong.");
      }
    });
  }

  function assign() {
    if (!assignTag) return;
    run(
      () => assignAssetAction(assignTag, person.id),
      () => {
        setAssignTag("");
        router.refresh();
      },
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link
        href="/people"
        className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to people
      </Link>

      {/* Header */}
      <div className="flex items-center gap-4">
        <span
          aria-hidden
          className="grid size-14 shrink-0 place-items-center rounded-full bg-accent text-lg font-semibold text-primary"
        >
          {person.initials}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-bold tracking-tight">
              {person.name}
            </h1>
            {archived ? (
              <Badge variant="secondary">Archived</Badge>
            ) : (
              <Badge variant="outline">Active</Badge>
            )}
          </div>
          {person.jobTitle || person.department ? (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {[person.jobTitle, person.department].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
      </div>

      {/* Profile */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl border bg-card p-5 sm:grid-cols-3">
        <Field label="Email" value={person.email} />
        <Field label="Phone" value={person.phone} mono />
        <Field label="Department" value={person.department} />
        <Field label="Job title" value={person.jobTitle} />
        <Field label="Employee id" value={person.employeeId} mono />
        <Field label="Office location" value={person.officeLocation} />
      </div>

      {/* Current devices */}
      <div>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Current devices ({currentDevices.length})
        </p>
        <div className="rounded-xl border bg-card p-5">
          {currentDevices.length ? (
            <ul className="divide-y text-sm">
              {currentDevices.map((d) => {
                const Icon = TYPE_ICON[d.type];
                return (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <Link
                          href={`/assets/${d.id}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {d.name}
                        </Link>
                        <span className="block font-mono text-[11px] text-muted-foreground">
                          {d.id} · since {fmtDateTime(d.assignedAt)}
                        </span>
                      </span>
                    </span>
                    {canWrite && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => run(() => returnAssetAction(d.id))}
                        disabled={isPending}
                      >
                        <Undo2 className="size-4" /> Return
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No devices assigned right now.
            </p>
          )}

          {/* Assign a device (active people only) */}
          {canWrite && !archived && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
              <Select
                value={assignTag || null}
                onValueChange={(v) => setAssignTag(v ?? "")}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder="Choose a device to assign…" />
                </SelectTrigger>
                <SelectContent>
                  {pickable.length ? (
                    pickable.map((a) => (
                      <SelectItem key={a.tag} value={a.tag}>
                        {a.name} ({a.tag})
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="" disabled>
                      No assignable devices
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              <Button onClick={assign} disabled={isPending || !assignTag}>
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                Assign
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Assignment history */}
      <div>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Assignment history
        </p>
        {history.length ? (
          <ol className="relative ml-1 border-l pl-5">
            {history.map((e) => (
              <li key={e.id} className="relative pb-5 last:pb-0">
                <span
                  className={cn(
                    "absolute -left-[23px] top-1 size-2.5 rounded-full border-2 bg-card",
                    e.open ? "border-primary" : "border-border",
                  )}
                />
                <p className="text-sm">
                  <Link
                    href={`/assets/${e.assetId}`}
                    className="font-medium hover:underline"
                  >
                    {e.assetName}
                  </Link>{" "}
                  <span className="text-muted-foreground">({e.assetId})</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Assigned {fmtDateTime(e.assignedAt)} by {e.assignedBy}
                </p>
                {e.open ? (
                  <p className="mt-0.5 text-xs text-[color:var(--status-online)]">
                    Currently held
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Returned {fmtDateTime(e.unassignedAt)} by {e.unassignedBy}
                  </p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-xl border border-dashed bg-card/50 p-5 text-sm text-muted-foreground">
            No assignment history yet.
          </p>
        )}
      </div>

      {/* Actions */}
      {canWrite && (
        <>
          <Separator />
          <div className="grid max-w-md grid-cols-2 gap-2">
            <Button onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" /> Edit
            </Button>
            {archived ? (
              <Button
                variant="outline"
                onClick={() => run(() => restorePersonAction(person.id))}
                disabled={isPending}
              >
                <ArchiveRestore className="size-4" /> Restore
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setArchiveOpen(true)}
                disabled={isPending}
              >
                <ArchiveX className="size-4" /> Archive
              </Button>
            )}
            {canDelete && (
              <Button
                variant="destructive"
                className="col-span-2"
                onClick={() => setDeleteOpen(true)}
                disabled={isPending}
              >
                <Trash2 className="size-4" /> Delete person
              </Button>
            )}
          </div>

          <PersonFormDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            mode="edit"
            locations={locations}
            editId={person.id}
            initial={formInitial}
          />

          {/* Archive confirm — returns their devices to the pool. */}
          <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
            <DialogContent showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>Archive {person.name}?</DialogTitle>
                <DialogDescription>
                  Their record and history are kept, but their{" "}
                  {currentDevices.length === 1
                    ? "1 device returns"
                    : `${currentDevices.length} devices return`}{" "}
                  to the pool and they drop out of the assignee picker. You can
                  restore them later.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setArchiveOpen(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    run(
                      () => archivePersonAction(person.id),
                      () => {
                        setArchiveOpen(false);
                        router.refresh();
                      },
                    )
                  }
                  disabled={isPending}
                >
                  {isPending && <Loader2 className="size-4 animate-spin" />}
                  Archive
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Delete confirm — only reachable when there's no history. */}
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogContent showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>Delete {person.name}?</DialogTitle>
                <DialogDescription>
                  This permanently removes the record. It&apos;s allowed only
                  because they have no assignment history. This can&apos;t be
                  undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDeleteOpen(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    run(
                      () => deletePersonAction(person.id),
                      () => {
                        setDeleteOpen(false);
                        router.push("/people");
                      },
                    )
                  }
                  disabled={isPending}
                >
                  {isPending && <Loader2 className="size-4 animate-spin" />}
                  Delete person
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
