"use client";

import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderInput,
  Loader2,
  MapPin,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  createLocation,
  deleteLocation,
  moveLocation,
  renameLocation,
} from "@/app/(app)/locations/actions";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type ActionResult,
  type LocationNode,
  type LocationOption,
} from "@/lib/data";
import { cn } from "@/lib/utils";

type ActiveDialog =
  | { kind: "create"; parent: LocationNode | null }
  | { kind: "rename"; node: LocationNode }
  | { kind: "move"; node: LocationNode }
  | { kind: "delete"; node: LocationNode };

export function LocationTree({
  tree,
  options,
  canWrite,
}: {
  tree: LocationNode[];
  options: LocationOption[];
  canWrite: boolean;
}) {
  const [dialog, setDialog] = React.useState<ActiveDialog | null>(null);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [isPending, startTransition] = React.useTransition();

  const total = options.length;

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        toast.success(res.message);
        setDialog(null);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Locations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The tree of places your assets live — regions, sites, rooms. Assign
            a device to a leaf (a location with no children) from its form.
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setDialog({ kind: "create", parent: null })}>
            <Plus className="size-4" /> Add location
          </Button>
        )}
      </header>

      {tree.length === 0 ? (
        <EmptyState canWrite={canWrite} onAdd={() => setDialog({ kind: "create", parent: null })} />
      ) : (
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Location</span>
            <span>{total} location{total === 1 ? "" : "s"}</span>
          </div>
          <ul className="p-2">
            {tree.map((node) => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                canWrite={canWrite}
                collapsed={collapsed}
                onToggle={toggle}
                onAddChild={(parent) => setDialog({ kind: "create", parent })}
                onRename={(n) => setDialog({ kind: "rename", node: n })}
                onMove={(n) => setDialog({ kind: "move", node: n })}
                onDelete={(n) => setDialog({ kind: "delete", node: n })}
              />
            ))}
          </ul>
        </div>
      )}

      {dialog?.kind === "create" && (
        <CreateDialog
          parent={dialog.parent}
          busy={isPending}
          onClose={() => setDialog(null)}
          onSubmit={(name) =>
            run(() =>
              createLocation({ name, parentId: dialog.parent?.id ?? null }),
            )
          }
        />
      )}

      {dialog?.kind === "rename" && (
        <RenameDialog
          node={dialog.node}
          busy={isPending}
          onClose={() => setDialog(null)}
          onSubmit={(name) => run(() => renameLocation(dialog.node.id, name))}
        />
      )}

      {dialog?.kind === "move" && (
        <MoveDialog
          node={dialog.node}
          options={options}
          busy={isPending}
          onClose={() => setDialog(null)}
          onSubmit={(newParentId) =>
            run(() => moveLocation(dialog.node.id, newParentId))
          }
        />
      )}

      {dialog?.kind === "delete" && (
        <DeleteDialog
          node={dialog.node}
          busy={isPending}
          onClose={() => setDialog(null)}
          onConfirm={() => run(() => deleteLocation(dialog.node.id))}
        />
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  canWrite,
  collapsed,
  onToggle,
  onAddChild,
  onRename,
  onMove,
  onDelete,
}: {
  node: LocationNode;
  depth: number;
  canWrite: boolean;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onAddChild: (parent: LocationNode) => void;
  onRename: (node: LocationNode) => void;
  onMove: (node: LocationNode) => void;
  onDelete: (node: LocationNode) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = !collapsed.has(node.id);

  return (
    <li>
      <div
        className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/50"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => onToggle(node.id)}
            aria-label={isOpen ? "Collapse" : "Expand"}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
          >
            {isOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}

        <MapPin
          className={cn(
            "size-4 shrink-0",
            hasChildren ? "text-primary" : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 truncate text-sm font-medium">
          {node.name}
        </span>

        {node.deviceCount > 0 && (
          <span className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {node.deviceCount} device{node.deviceCount === 1 ? "" : "s"}
          </span>
        )}
        {!hasChildren && (
          <span className="shrink-0 text-[11px] text-muted-foreground/70">
            leaf
          </span>
        )}

        {canWrite && (
          <div className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label={`Actions for ${node.name}`}
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => onAddChild(node)}>
                  <Plus className="size-4" /> Add child
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRename(node)}>
                  <Pencil className="size-4" /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMove(node)}>
                  <FolderInput className="size-4" /> Move
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDelete(node)}
                >
                  <Trash2 className="size-4" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {hasChildren && isOpen && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              canWrite={canWrite}
              collapsed={collapsed}
              onToggle={onToggle}
              onAddChild={onAddChild}
              onRename={onRename}
              onMove={onMove}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ---------------- Dialogs ---------------- */

function CreateDialog({
  parent,
  busy,
  onClose,
  onSubmit,
}: {
  parent: LocationNode | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  return (
    <NameDialog
      open
      title={parent ? `Add a location under "${parent.name}"` : "Add a location"}
      description={
        parent
          ? "The new location becomes a child of the selected one."
          : "The new location sits at the top level of the tree."
      }
      confirmLabel="Create"
      initial=""
      busy={busy}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function RenameDialog({
  node,
  busy,
  onClose,
  onSubmit,
}: {
  node: LocationNode;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  return (
    <NameDialog
      open
      title={`Rename "${node.name}"`}
      description="The new name shows everywhere this location is used."
      confirmLabel="Save"
      initial={node.name}
      busy={busy}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

/** Shared single-text-field dialog for create and rename, with inline
   validation matching the server (name required, max 100). */
function NameDialog({
  open,
  title,
  description,
  confirmLabel,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  initial: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    if (trimmed.length > 100) {
      setError("Name is too long (max 100 characters)");
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Name
            </span>
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder="e.g. New York"
              aria-invalid={!!error}
            />
            {error && <span className="text-xs text-destructive">{error}</span>}
          </label>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MoveDialog({
  node,
  options,
  busy,
  onClose,
  onSubmit,
}: {
  node: LocationNode;
  options: LocationOption[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (newParentId: string) => void;
}) {
  // A location can't move under itself or any descendant (would form a cycle),
  // nor under a location that already holds devices. The server enforces this
  // too; here we just keep those choices out of the picker.
  const blocked = React.useMemo(() => {
    const childrenByParent = new Map<string, string[]>();
    for (const o of options) {
      if (o.parentId) {
        const arr = childrenByParent.get(o.parentId) ?? [];
        arr.push(o.id);
        childrenByParent.set(o.parentId, arr);
      }
    }
    const out = new Set<string>([node.id]);
    const stack = [node.id];
    while (stack.length) {
      const id = stack.pop()!;
      for (const child of childrenByParent.get(id) ?? []) {
        if (!out.has(child)) {
          out.add(child);
          stack.push(child);
        }
      }
    }
    return out;
  }, [options, node.id]);

  const targets = options.filter((o) => !blocked.has(o.id));
  const [value, setValue] = React.useState<string>("");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move &ldquo;{node.name}&rdquo;</DialogTitle>
          <DialogDescription>
            Choose a new parent. The whole subtree under this location moves with
            it. Its own descendants aren&apos;t listed.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(value);
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              New parent
            </span>
            <Select value={value} onValueChange={(v) => setValue(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Top level (no parent)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Top level (no parent)</SelectItem>
                {targets.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  node,
  busy,
  onClose,
  onConfirm,
}: {
  node: LocationNode;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const blocked =
    node.children.length > 0 || node.deviceCount > 0
      ? node.children.length > 0
        ? "It has child locations. Move or delete them first."
        : "It has devices assigned. Reassign them first."
      : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{node.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            {blocked
              ? `This location can't be deleted yet. ${blocked}`
              : "This location will be permanently removed. This can't be undone."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {blocked ? "Close" : "Cancel"}
          </Button>
          {!blocked && (
            <Button variant="destructive" onClick={onConfirm} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({
  canWrite,
  onAdd,
}: {
  canWrite: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="grid place-content-center gap-3 rounded-xl border border-dashed bg-card/50 py-20 text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent text-primary">
        <MapPin className="size-7" />
      </span>
      <p className="text-lg font-semibold">No locations yet</p>
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">
        {canWrite
          ? "Build your tree of regions, sites and rooms. Start with a top-level location."
          : "No locations have been set up yet. Ask an admin with location access to add them."}
      </p>
      {canWrite && (
        <Button className="mx-auto mt-1" onClick={onAdd}>
          <Plus className="size-4" /> Add location
        </Button>
      )}
    </div>
  );
}
