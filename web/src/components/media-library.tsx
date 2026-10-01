"use client";

import * as React from "react";
import Link from "next/link";
import {
  Database,
  Image as ImageIcon,
  Images,
  LayoutGrid,
  Link2,
  List as ListIcon,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { HeroHeader } from "@/components/hero-header";
import { PagePlaceholder } from "@/components/page-placeholder";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type MediaLibraryItem = {
  id: string;
  name: string;
  altText: string | null;
  notes: string | null;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  usedBy: number;
  thumbUrl: string;
};

export type MediaLibraryStats = {
  totalImages: number;
  assetsUsingImages: number;
  totalSizeBytes: number;
};

const ACCEPT_ATTR = "image/png,image/jpeg,image/webp";
const ASSET_TYPES = ["Computer", "Monitor", "Printer", "Phone", "Network"] as const;

function typeLabel(contentType: string): string {
  const sub = contentType.split("/")[1]?.toUpperCase() ?? "IMG";
  return sub === "JPEG" ? "JPG" : sub;
}
function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function dims(m: MediaLibraryItem): string {
  return m.width && m.height ? `${m.width}×${m.height}` : "—";
}

/**
 * The shared media library dashboard (spec 18 UI). Browse, search, filter by asset
 * type, sort by most-used/recent, toggle grid/list, and — for `asset:write` users —
 * upload, edit, and delete (blocked while in use). Each card links to the media
 * detail page; reuse-onto-an-asset happens from the asset photo control, not here.
 */
export function MediaLibrary({
  initialItems,
  initialNextOffset,
  stats: initialStats,
  canWrite,
}: {
  initialItems: MediaLibraryItem[];
  initialNextOffset: number | null;
  stats: MediaLibraryStats;
  canWrite: boolean;
}) {
  const [items, setItems] = React.useState(initialItems);
  const [nextOffset, setNextOffset] = React.useState(initialNextOffset);
  const [stats, setStats] = React.useState(initialStats);
  const [q, setQ] = React.useState("");
  const [type, setType] = React.useState<string>("all");
  const [sort, setSort] = React.useState<"recent" | "most-used">("recent");
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [loading, setLoading] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [editing, setEditing] = React.useState<MediaLibraryItem | null>(null);
  const uploadRef = React.useRef<HTMLInputElement>(null);
  const mounted = React.useRef(false);

  const buildUrl = React.useCallback(
    (offset: number) => {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (type !== "all") p.set("type", type);
      if (sort !== "recent") p.set("sort", sort);
      if (offset) p.set("offset", String(offset));
      const qs = p.toString();
      return qs ? `/api/media?${qs}` : "/api/media";
    },
    [q, type, sort],
  );

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(buildUrl(0));
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setItems(data.items ?? []);
      setNextOffset(data.nextOffset ?? null);
    } catch {
      toast.error("Could not load the media library.");
    } finally {
      setLoading(false);
    }
  }, [buildUrl]);

  // Refetch when the query/filter/sort change (debounced); skip the first mount.
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => void reload(), 200);
    return () => clearTimeout(t);
  }, [reload]);

  async function loadMore() {
    if (nextOffset == null) return;
    setLoading(true);
    try {
      const res = await fetch(buildUrl(nextOffset));
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setItems((prev) => [...prev, ...(data.items ?? [])]);
      setNextOffset(data.nextOffset ?? null);
    } catch {
      toast.error("Could not load more images.");
    } finally {
      setLoading(false);
    }
  }

  async function uploadFiles(files: FileList) {
    setUploading(true);
    let ok = 0;
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/media", { method: "POST", body });
        if (res.ok) ok += 1;
        else {
          const data = await res.json().catch(() => null);
          toast.error(data?.error ?? `Could not upload ${file.name}.`);
        }
      }
      if (ok > 0) {
        toast.success(ok === 1 ? "Image added." : `${ok} images added.`);
        await reload();
        setStats((s) => ({ ...s, totalImages: s.totalImages + ok }));
      }
    } finally {
      setUploading(false);
    }
  }

  async function remove(m: MediaLibraryItem) {
    const res = await fetch(`/api/media/${m.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Image deleted.");
      setItems((prev) => prev.filter((x) => x.id !== m.id));
      setStats((s) => ({
        ...s,
        totalImages: Math.max(0, s.totalImages - 1),
        totalSizeBytes: Math.max(0, s.totalSizeBytes - m.sizeBytes),
      }));
      return;
    }
    if (res.status === 409) {
      const data = await res.json().catch(() => null);
      const n = data?.usedBy ?? m.usedBy;
      toast.error(
        `Can't delete — ${n} ${n === 1 ? "asset uses" : "assets use"} this image. Reassign them first.`,
      );
      return;
    }
    toast.error("Could not delete the image.");
  }

  function onEdited(updated: MediaLibraryItem) {
    setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    setEditing(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <HeroHeader
        icon={<Images />}
        title="Media"
        subtitle="The shared image library. Upload a photo once and reuse it across any number of identical assets. Each image shows how many assets use it."
        actions={
          canWrite ? (
            <>
              <input
                ref={uploadRef}
                type="file"
                accept={ACCEPT_ATTR}
                multiple
                className="sr-only"
                aria-label="Upload images"
                onChange={(e) => {
                  const files = e.target.files;
                  e.target.value = "";
                  if (files && files.length) void uploadFiles(files);
                }}
              />
              <Button onClick={() => uploadRef.current?.click()} disabled={uploading}>
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                Upload Image
              </Button>
            </>
          ) : undefined
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<ImageIcon />}
          value={String(stats.totalImages)}
          label="Total Images"
        />
        <StatCard
          icon={<Link2 />}
          value={String(stats.assetsUsingImages)}
          label="Assets Using Images"
        />
        <StatCard
          icon={<Database />}
          value={fileSize(stats.totalSizeBytes)}
          label="Total Size"
        />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or notes…"
            className="pl-8"
          />
        </div>
        <Select value={type} onValueChange={(v) => setType(v ?? "all")}>
          <SelectTrigger className="h-9">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {ASSET_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={(v) => setSort((v as "recent" | "most-used") ?? "recent")}
        >
          <SelectTrigger className="h-9">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="most-used">Most Used</SelectItem>
            <SelectItem value="recent">Most Recent</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
          <ViewToggle
            active={view === "grid"}
            onClick={() => setView("grid")}
            label="Grid view"
          >
            <LayoutGrid className="size-4" />
          </ViewToggle>
          <ViewToggle
            active={view === "list"}
            onClick={() => setView("list")}
            label="List view"
          >
            <ListIcon className="size-4" />
          </ViewToggle>
        </div>
      </div>

      {items.length === 0 ? (
        <PagePlaceholder
          title={
            q.trim() || type !== "all"
              ? "No images match those filters"
              : "The library is empty"
          }
          description={
            q.trim() || type !== "all"
              ? "Try a different search or clear the filters."
              : canWrite
                ? "Upload an image to get started, or add one from any asset's photo control."
                : "Images added from assets will show here."
          }
          icon={Images}
        />
      ) : view === "grid" ? (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((m) => (
            <li
              key={m.id}
              className="group relative flex flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md"
            >
              <Link href={`/media/${m.id}`} className="block">
                <span className="relative block">
                  {/* eslint-disable-next-line @next/next/no-img-element -- private route */}
                  <img
                    src={m.thumbUrl}
                    alt={m.altText ?? m.name}
                    className="aspect-[4/3] w-full bg-accent-soft object-cover"
                  />
                  <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-card/90 px-2 py-0.5 text-xs font-semibold text-foreground ring-1 ring-foreground/10 backdrop-blur">
                    <Users className="size-3" />
                    {m.usedBy}
                  </span>
                </span>
                <span className="block px-3 pt-3">
                  <span className="block truncate text-sm font-semibold" title={m.name}>
                    {m.name}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <ImageIcon className="size-3" />
                    {typeLabel(m.contentType)} · {fileSize(m.sizeBytes)}
                  </span>
                </span>
              </Link>
              <div className="mt-2 flex items-center justify-between border-t px-3 py-2">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Link2 className="size-3.5" />
                  Used by {m.usedBy} {m.usedBy === 1 ? "asset" : "assets"}
                </span>
                {canWrite && <CardMenu m={m} onEdit={setEditing} onDelete={remove} />}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <ul className="divide-y">
            {items.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                <Link href={`/media/${m.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- private route */}
                  <img
                    src={m.thumbUrl}
                    alt={m.altText ?? m.name}
                    className="size-10 shrink-0 rounded-md bg-accent-soft object-cover ring-1 ring-foreground/10"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{m.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {typeLabel(m.contentType)} · {fileSize(m.sizeBytes)} · {dims(m)}
                    </span>
                  </span>
                </Link>
                <Badge variant="secondary" className="tabular-nums">
                  used by {m.usedBy}
                </Badge>
                {canWrite && <CardMenu m={m} onEdit={setEditing} onDelete={remove} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {nextOffset != null && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loading}>
            {loading && <Loader2 className="size-4 animate-spin" />}
            Load more
          </Button>
        </div>
      )}

      {editing && (
        <EditMediaDialog
          item={editing}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={onEdited}
        />
      )}
    </div>
  );
}

function StatCard({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border bg-card px-5 py-4">
      <span
        aria-hidden
        className="grid size-11 shrink-0 place-items-center rounded-(--radius-control) bg-accent-soft text-primary [&_svg]:size-5"
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-bold tabular-nums leading-none">
          {value}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function ViewToggle({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "grid size-7 place-items-center rounded-md transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function CardMenu({
  m,
  onEdit,
  onDelete,
}: {
  m: MediaLibraryItem;
  onEdit: (m: MediaLibraryItem) => void;
  onDelete: (m: MediaLibraryItem) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label={`Actions for ${m.name}`}
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={() => onEdit(m)}>
          <Pencil className="size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={m.usedBy > 0}
          onClick={() => onDelete(m)}
        >
          <Trash2 className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Edit a media row's name / alt text / notes (AC-5), via PATCH /api/media/[id]. */
export function EditMediaDialog({
  item,
  onOpenChange,
  onSaved,
}: {
  item: MediaLibraryItem;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: MediaLibraryItem) => void;
}) {
  const [name, setName] = React.useState(item.name);
  const [altText, setAltText] = React.useState(item.altText ?? "");
  const [notes, setNotes] = React.useState(item.notes ?? "");
  const [saving, setSaving] = React.useState(false);

  async function save() {
    if (!name.trim()) {
      toast.error("A name is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/media/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), altText, notes }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "Could not save.");
        return;
      }
      toast.success("Saved.");
      onSaved({
        ...item,
        name: name.trim(),
        altText: altText.trim() || null,
        notes: notes.trim() || null,
      });
    } catch {
      toast.error("Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit image</DialogTitle>
          <DialogDescription>
            Rename the image and add alt text or notes to help find and reuse it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Alt text
            <Input
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              placeholder="Describes the image for screen readers"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Notes
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Where this came from, which model it shows, etc."
              rows={3}
            />
          </label>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
