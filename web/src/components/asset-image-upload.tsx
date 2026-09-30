"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ImageUp, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AssetImage } from "@/components/asset-image";
import { Button } from "@/components/ui/button";
import type { AssetType } from "@/lib/data";
import { cn } from "@/lib/utils";

// Kept in step with src/lib/storage.ts (that module is server-only, so the
// limits are restated here for instant client-side feedback; the server still
// re-validates every upload).
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];
const ACCEPT_ATTR = ACCEPTED.join(",");
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * The asset product photo on the detail page (spec 17.02): shows the current
 * image (or the type icon), and for `asset:write` users, upload/replace (pick or
 * drop a file) and remove. Validates type and size client-side for quick
 * feedback; the route re-validates and is the real gate.
 */
export function AssetImageUpload({
  tag,
  imageKey,
  type,
  name,
  canWrite = false,
}: {
  tag: string;
  imageKey?: string | null;
  type: AssetType;
  name: string;
  canWrite?: boolean;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);

  async function upload(file: File) {
    if (!ACCEPTED.includes(file.type)) {
      toast.error("Please choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("That image is larger than 5 MB.");
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/assets/${encodeURIComponent(tag)}/image`, {
        method: "POST",
        body,
      });
      if (res.ok) {
        toast.success("Photo updated.");
        router.refresh();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "Upload failed.");
      }
    } catch {
      toast.error("Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(tag)}/image`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Photo removed.");
        router.refresh();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "Could not remove the photo.");
      }
    } catch {
      toast.error("Could not remove the photo.");
    } finally {
      setBusy(false);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (file) void upload(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!canWrite || busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          if (!canWrite) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "relative size-28 overflow-hidden rounded-(--radius-card) ring-1 ring-foreground/10",
          canWrite && "cursor-pointer",
          dragOver && "ring-2 ring-primary",
        )}
        onClick={() => canWrite && !busy && inputRef.current?.click()}
        role={canWrite ? "button" : undefined}
        aria-label={canWrite ? "Upload asset photo" : undefined}
        tabIndex={canWrite ? 0 : undefined}
        onKeyDown={(e) => {
          if (canWrite && !busy && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <AssetImage
          tag={tag}
          imageKey={imageKey}
          type={type}
          alt={imageKey ? `Photo of ${name}` : ""}
          className="size-full"
          iconClassName="size-10"
        />
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-card/60">
            <Loader2 className="size-5 animate-spin text-primary" />
          </span>
        )}
      </div>

      {canWrite && (
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={onPick}
            className="sr-only"
            aria-label="Asset photo file"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <ImageUp className="size-4" />
            {imageKey ? "Replace" : "Upload"}
          </Button>
          {imageKey && (
            <Button
              variant="ghost"
              size="sm"
              onClick={remove}
              disabled={busy}
            >
              <Trash2 className="size-4" />
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
