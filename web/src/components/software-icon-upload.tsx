"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ImageOff, ImagePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * Admin control to upload/replace or remove a tracked title's brand icon (spec 22).
 * Posts to the `/api/software/[id]/icon` route (scan:write, rechecked server-side),
 * then refreshes so the new icon (or fallback glyph) shows everywhere it is used.
 * Only rendered inside the Admin "Tracked software" card, which is already gated.
 */
export function SoftwareIconUpload({
  id,
  name,
  hasCustomIcon,
}: {
  id: string;
  name: string;
  hasCustomIcon: boolean;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/software/${id}/icon`, {
        method: "POST",
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(`Icon updated for ${name}.`);
        router.refresh();
      } else {
        toast.error(data.error ?? "Could not upload the icon.");
      }
    } catch {
      toast.error("Could not upload the icon.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/software/${id}/icon`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(`Icon removed from ${name}.`);
        router.refresh();
      } else {
        toast.error(data.error ?? "Could not remove the icon.");
      }
    } catch {
      toast.error("Could not remove the icon.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label={
          hasCustomIcon ? `Replace icon for ${name}` : `Upload icon for ${name}`
        }
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ImagePlus className="size-4" />
        )}
      </Button>
      {hasCustomIcon && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          onClick={remove}
          disabled={busy}
          aria-label={`Remove icon from ${name}`}
        >
          <ImageOff className="size-4" />
        </Button>
      )}
    </div>
  );
}
