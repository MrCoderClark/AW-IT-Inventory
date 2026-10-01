"use client";

import * as React from "react";
import { Loader2, Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** One image as returned by GET /api/media. */
type MediaItem = {
  id: string;
  name: string;
  usedBy: number;
  thumbUrl: string;
};

/**
 * Pick an existing library image to reuse on an asset (spec 18, AC-2). Fetches the
 * library on open and on search; selecting an image calls `onPick` with its id. The
 * caller is responsible for assigning it (the `setAssetImage` server action).
 */
export function MediaPickerDialog({
  open,
  onOpenChange,
  onPick,
  currentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (mediaId: string) => void;
  currentId?: string | null;
}) {
  const [q, setQ] = React.useState("");
  const [items, setItems] = React.useState<MediaItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset the search each time the dialog opens.
  React.useEffect(() => {
    if (open) setQ("");
  }, [open]);

  // Load the library whenever open and the (debounced) query changes.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const url = q.trim()
          ? `/api/media?q=${encodeURIComponent(q.trim())}`
          : "/api/media";
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!cancelled) setItems(data.items ?? []);
      } catch {
        if (!cancelled) setError("Could not load the media library.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, q]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose from library</DialogTitle>
          <DialogDescription>
            Reuse an image already in the library. Upload a new one from the photo
            controls instead.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or notes…"
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="max-h-[60vh] min-h-40 overflow-y-auto">
          {loading && (
            <div className="grid h-40 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {!loading && error && (
            <p className="grid h-40 place-items-center text-sm text-destructive">
              {error}
            </p>
          )}
          {!loading && !error && items.length === 0 && (
            <p className="grid h-40 place-items-center text-sm text-muted-foreground">
              {q.trim() ? "No images match that search." : "The library is empty."}
            </p>
          )}
          {!loading && !error && items.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 p-0.5 sm:grid-cols-3">
              {items.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => onPick(m.id)}
                    className={cn(
                      "group flex w-full flex-col overflow-hidden rounded-(--radius-card) text-left ring-1 ring-foreground/10 transition hover:ring-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
                      m.id === currentId && "ring-2 ring-primary",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- private route */}
                    <img
                      src={m.thumbUrl}
                      alt={m.name}
                      className="aspect-square w-full bg-accent-soft object-cover"
                    />
                    <span className="truncate px-2 py-1.5 text-xs font-medium">
                      {m.name}
                      <span className="ml-1 font-normal text-muted-foreground">
                        · used by {m.usedBy}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
