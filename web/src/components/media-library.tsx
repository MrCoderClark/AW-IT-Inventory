"use client";

import * as React from "react";
import { Images, Loader2, Pencil, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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

const ACCEPT_ATTR = "image/png,image/jpeg,image/webp";

function dims(m: MediaLibraryItem): string {
  if (m.width && m.height) return `${m.width}×${m.height}`;
  return "—";
}

function kb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The shared media library grid (spec 18, AC-5): browse, search, and — for
 * `asset:write` users — upload, edit metadata, and delete (blocked while in use).
 * Reuse-on-an-asset happens from the asset photo control, not here.
 */
export function MediaLibrary({
  initialItems,
  initialCursor,
  canWrite,
}: {
  initialItems: MediaLibraryItem[];
  initialCursor: string | null;
  canWrite: boolean;
}) {
  const [items, setItems] = React.useState(initialItems);
  const [cursor, setCursor] = React.useState(initialCursor);
  const [q, setQ] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [editing, setEditing] = React.useState<MediaLibraryItem | null>(null);
  const uploadRef = React.useRef<HTMLInputElement>(null);
  // Skip the search fetch on first mount (the server already sent page 1).
  const mounted = React.useRef(false);

  const runSearch = React.useCallback(async (query: string) => {
    setLoading(true);
    try {
      const url = query.trim()
        ? `/api/media?q=${encodeURIComponent(query.trim())}`
        : "/api/media";
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setItems(data.items ?? []);
      setCursor(data.nextCursor ?? null);
    } catch {
      toast.error("Could not load the media library.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => void runSearch(q), 200);
    return () => clearTimeout(t);
  }, [q, runSearch]);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      params.set("cursor", cursor);
      const res = await fetch(`/api/media?${params.toString()}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setItems((prev) => [...prev, ...(data.items ?? [])]);
      setCursor(data.nextCursor ?? null);
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
        await runSearch(q);
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
    <div className="flex flex-col gap-4">
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
        {canWrite && (
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
            <Button
              onClick={() => uploadRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              Upload image
            </Button>
          </>
        )}
      </div>

      {items.length === 0 ? (
        <PagePlaceholder
          title={q.trim() ? "No images match that search" : "The library is empty"}
          description={
            q.trim()
              ? "Try a different name or clear the search."
              : canWrite
                ? "Upload an image to get started, or add one from any asset's photo control."
                : "Images added from assets will show here."
          }
          icon={Images}
        />
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((m) => (
            <li
              key={m.id}
              className="flex flex-col overflow-hidden rounded-xl border bg-card"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- private route */}
              <img
                src={m.thumbUrl}
                alt={m.altText ?? m.name}
                className="aspect-square w-full bg-accent-soft object-cover"
              />
              <div className="flex flex-1 flex-col gap-2 p-3">
                <p className="truncate text-sm font-medium" title={m.name}>
                  {m.name}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Badge variant="secondary" className="tabular-nums">
                    used by {m.usedBy}
                  </Badge>
                  <span className="tabular-nums">{dims(m)}</span>
                  <span>·</span>
                  <span className="tabular-nums">{kb(m.sizeBytes)}</span>
                </div>
                {canWrite && (
                  <div className="mt-auto flex items-center gap-1 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(m)}
                    >
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(m)}
                      disabled={m.usedBy > 0}
                      title={
                        m.usedBy > 0
                          ? "In use — reassign the assets that use it first"
                          : "Delete this image"
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
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

/** Edit a media row's name / alt text / notes (AC-5), via PATCH /api/media/[id]. */
function EditMediaDialog({
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
