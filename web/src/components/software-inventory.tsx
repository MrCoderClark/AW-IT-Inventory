"use client";

import * as React from "react";
import Link from "next/link";
import {
  AppWindow,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Package,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  addTrackedSoftwareAction,
  removeTrackedSoftwareAction,
} from "@/app/(app)/software-actions";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SoftwareInventoryRow } from "@/lib/data";

const PAGE_SIZE = 10;
const ALL = "__all__";

/** Deterministic date label (UTC) so server and client render the same string. */
const DAY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
});
function fmtDay(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DAY_FMT.format(d);
}

/**
 * The /software dashboard table (spec 22). Takes the full tracked-title aggregate
 * and does search, publisher/version filtering and pagination on the client — the
 * watchlist is small, so there is no need to round-trip. Viewing is open to any
 * `asset:read` user; the Add / Remove controls render only for a `scan:write`
 * writer and each backing server action re-checks the permission (AC-7).
 */
export function SoftwareInventory({
  rows,
  canWrite = false,
}: {
  rows: SoftwareInventoryRow[];
  canWrite?: boolean;
}) {
  const [search, setSearch] = React.useState("");
  const [publisher, setPublisher] = React.useState(ALL);
  const [version, setVersion] = React.useState(ALL);
  const [page, setPage] = React.useState(0);
  const [addOpen, setAddOpen] = React.useState(false);

  // Distinct filter options, gathered once from the rows.
  const publisherOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const p of r.publishers) set.add(p);
    return [...set].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [rows]);

  const versionOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const v of r.versions) set.add(v);
    return [...set].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
  }, [rows]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (publisher !== ALL && !r.publishers.includes(publisher)) return false;
      if (version !== ALL && !r.versions.includes(version)) return false;
      if (!term) return true;
      return (
        r.name.toLowerCase().includes(term) ||
        r.publishers.some((p) => p.toLowerCase().includes(term)) ||
        r.versions.some((v) => v.toLowerCase().includes(term))
      );
    });
  }, [rows, search, publisher, version]);

  const pageCount = Math.max(Math.ceil(filtered.length / PAGE_SIZE), 1);
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(
    clampedPage * PAGE_SIZE,
    clampedPage * PAGE_SIZE + PAGE_SIZE,
  );
  const first = filtered.length === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
  const last = clampedPage * PAGE_SIZE + pageRows.length;

  return (
    <div className="rounded-xl border bg-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search software title…"
            className="pl-9"
          />
        </div>

        <Select
          value={publisher}
          onValueChange={(v) => {
            setPublisher(v ?? ALL);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Publishers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Publishers</SelectItem>
            {publisherOptions.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={version}
          onValueChange={(v) => {
            setVersion(v ?? ALL);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Versions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Versions</SelectItem>
            {versionOptions.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {canWrite && (
          <div className="ml-auto">
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" /> Add software
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Software title</TableHead>
              <TableHead>Publisher</TableHead>
              <TableHead>Version</TableHead>
              <TableHead className="w-[110px] text-right">Computers</TableHead>
              <TableHead className="w-[140px]">Last updated</TableHead>
              <TableHead className="w-[140px]" aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length ? (
              pageRows.map((r) => (
                <TableRow key={r.id} className="group">
                  <TableCell>
                    <Link
                      href={`/software/${r.id}`}
                      className="flex items-center gap-2.5 font-medium hover:underline"
                    >
                      <SoftwareIcon iconUrl={r.iconUrl} name={r.name} />
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.publishers.length === 0
                      ? "—"
                      : r.publishers.length === 1
                        ? r.publishers[0]
                        : "Multiple"}
                  </TableCell>
                  <TableCell>
                    {r.versions.length === 0 ? (
                      <span className="text-sm text-muted-foreground">—</span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <Badge variant="secondary" className="font-mono">
                          {r.versions[r.versions.length - 1]}
                        </Badge>
                        {r.versions.length > 1 && (
                          <span className="text-xs text-muted-foreground">
                            +{r.versions.length - 1}
                          </span>
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.machineCount === 0 ? (
                      <span className="text-muted-foreground">0</span>
                    ) : (
                      r.machineCount
                    )}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {fmtDay(r.lastSeen)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        nativeButton={false}
                        render={<Link href={`/software/${r.id}`} />}
                      >
                        View details
                      </Button>
                      <RowMenu row={r} canWrite={canWrite} />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center">
                  <span className="inline-flex flex-col items-center gap-2 text-muted-foreground">
                    <AppWindow className="size-6" />
                    <span className="text-sm">
                      {rows.length === 0
                        ? "No software tracked yet. Add a title to start watching for it across the fleet."
                        : "No software matches your filters."}
                    </span>
                  </span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between gap-2 border-t p-4">
        <p className="text-sm text-muted-foreground">
          {filtered.length === 0
            ? "No software titles"
            : `Showing ${first}–${last} of ${filtered.length} software ${
                filtered.length === 1 ? "title" : "titles"
              }`}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(p - 1, 0))}
            disabled={clampedPage === 0}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(p + 1, pageCount - 1))}
            disabled={clampedPage >= pageCount - 1}
          >
            Next
          </Button>
        </div>
      </div>

      {canWrite && <AddSoftwareDialog open={addOpen} onOpenChange={setAddOpen} />}
    </div>
  );
}

/** A title's brand icon (resolved custom → registry), falling back to a glyph. */
function SoftwareIcon({
  iconUrl,
  name,
}: {
  iconUrl: string | null;
  name: string;
}) {
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        aria-hidden
        data-testid={`software-icon-${name}`}
        className="size-7 shrink-0 rounded-md object-contain"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-primary [&_svg]:size-4"
    >
      <Package />
    </span>
  );
}

/** Per-row actions menu: view, and (writers only) stop tracking the title. */
function RowMenu({
  row,
  canWrite,
}: {
  row: SoftwareInventoryRow;
  canWrite: boolean;
}) {
  const [isRemoving, startRemove] = React.useTransition();

  function remove() {
    startRemove(async () => {
      const res = await removeTrackedSoftwareAction(row.id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label={`Actions for ${row.name}`}
          />
        }
      >
        {isRemoving ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <MoreHorizontal className="size-4" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem render={<Link href={`/software/${row.id}`} />}>
          <ChevronRight className="size-4" /> View details
        </DropdownMenuItem>
        {canWrite && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={remove}>
              <Trash2 className="size-4" /> Stop tracking
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Add a title to the watchlist inline, reusing the Admin-page server action. */
function AddSoftwareDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = React.useState("");
  const [isAdding, startAdd] = React.useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    startAdd(async () => {
      const res = await addTrackedSoftwareAction(value);
      if (res.ok) {
        toast.success(res.message);
        setName("");
        onOpenChange(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add software to the watchlist</DialogTitle>
            <DialogDescription>
              Track a title across the fleet. The name is also the match term —
              any installed program whose name contains it is counted.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Google Chrome"
              aria-label="Software title to track"
              disabled={isAdding}
              maxLength={200}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isAdding}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isAdding || !name.trim()}>
              {isAdding ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add software
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
