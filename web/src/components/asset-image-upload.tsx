"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ImageUp, Images, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AssetImage } from "@/components/asset-image";
import { MediaPickerDialog } from "@/components/media-picker-dialog";
import { Button } from "@/components/ui/button";
import { setAssetImage } from "@/app/(app)/media-actions";
import type { AssetType } from "@/lib/data";
import { cn } from "@/lib/utils";

// Kept in step with src/lib/storage.ts (that module is server-only, so the
// limits are restated here for instant client-side feedback; the server still
// re-validates every upload).
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];
const ACCEPT_ATTR = ACCEPTED.join(",");
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * The asset product photo control on the detail page (spec 18, superseding spec
 * 17.02). Shows the current image (or the type icon), and for `asset:write` users:
 *   - Upload new  — adds the file to the shared media library, then assigns it.
 *   - Choose from library — reuse an existing library image (the whole point of
 *     spec 18: one upload, many identical devices).
 *   - Remove — clears the asset's pointer; the library image stays for reuse.
 * Uploading is two steps (POST /api/media → `setAssetImage`), so an identical photo
 * already in the library is deduped rather than re-stored.
 */
export function AssetImageUpload({
  tag,
  imageId,
  imageVersion,
  type,
  name,
  model,
  canWrite = false,
  showButtons = true,
  boxClassName,
  iconClassName,
}: {
  tag: string;
  imageId?: string | null;
  /** Cache-buster so the shown image updates when the cut-out is toggled (spec 18
     phase 3). Falls back to `imageId`. */
  imageVersion?: string | null;
  type: AssetType;
  name: string;
  /** The device model, used as the default library name on upload — the image is
     shared across identical devices, so the model identifies it, not one asset. */
  model?: string | null;
  canWrite?: boolean;
  /** Show the button row under the image (default true). The printer detail header
     hides it and uses click/drag on the image to upload. */
  showButtons?: boolean;
  /** Override the image box size/shape (default a 28-unit square). */
  boxClassName?: string;
  /** Override the fallback icon size. */
  iconClassName?: string;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  /** Assign (or clear) the asset's media pointer via the server action. */
  async function assign(mediaId: string | null, successMsg: string) {
    const res = await setAssetImage(tag, mediaId);
    if (res.ok) {
      toast.success(res.message ?? successMsg);
      router.refresh();
    } else {
      toast.error(res.error ?? "Could not update the photo.");
    }
  }

  /** Upload a new file into the library, then assign it to this asset. */
  async function uploadNew(file: File) {
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
      // Default the library name to the device model — the image is reused across
      // identical devices, so the model identifies it, not one asset's name/tag.
      // No model → let the API fall back to the uploaded file name. Editable on /media.
      const title = model?.trim();
      if (title) body.append("name", title);
      const res = await fetch("/api/media", { method: "POST", body });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "Upload failed.");
        return;
      }
      const data = await res.json();
      await assign(data.media.id, "Photo updated.");
    } catch {
      toast.error("Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseFromLibrary(mediaId: string) {
    setPickerOpen(false);
    setBusy(true);
    try {
      await assign(mediaId, "Photo updated.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await assign(null, "Photo removed.");
    } finally {
      setBusy(false);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (file) void uploadNew(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!canWrite || busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadNew(file);
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
          "relative overflow-hidden rounded-(--radius-card) ring-1 ring-foreground/10",
          boxClassName ?? "size-28",
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
          imageId={imageId}
          version={imageVersion}
          type={type}
          alt={imageId ? `Photo of ${name}` : ""}
          className="size-full"
          iconClassName={iconClassName ?? "size-10"}
        />
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-card/60">
            <Loader2 className="size-5 animate-spin text-primary" />
          </span>
        )}
      </div>

      {/* Always rendered for writers, so click/drag on the image works even when
         the button row is hidden (the printer detail header). */}
      {canWrite && (
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          onChange={onPick}
          className="sr-only"
          aria-label="Asset photo file"
        />
      )}

      {canWrite && showButtons && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <ImageUp className="size-4" />
            {imageId ? "Replace" : "Upload new"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
          >
            <Images className="size-4" />
            Choose from library
          </Button>
          {imageId && (
            <Button variant="ghost" size="sm" onClick={remove} disabled={busy}>
              <Trash2 className="size-4" />
              Remove
            </Button>
          )}
        </div>
      )}

      {canWrite && (
        <MediaPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={chooseFromLibrary}
          currentId={imageId}
        />
      )}
    </div>
  );
}
