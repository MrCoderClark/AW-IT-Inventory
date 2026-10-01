"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  EditMediaDialog,
  type MediaLibraryItem,
} from "@/components/media-library";
import { Button } from "@/components/ui/button";

/**
 * Writer actions on the media detail page (spec 18 UI): edit metadata (reusing the
 * library's edit dialog) and delete (blocked while in use; on success returns to the
 * library). Replacing the underlying file is intentionally out of scope here — the
 * image is shared, so changing its bytes would affect every asset using it.
 */
export function MediaDetailActions({ item }: { item: MediaLibraryItem }) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);

  async function remove() {
    const res = await fetch(`/api/media/${item.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Image deleted.");
      router.push("/media");
      return;
    }
    if (res.status === 409) {
      const data = await res.json().catch(() => null);
      const n = data?.usedBy ?? item.usedBy;
      toast.error(
        `Can't delete — ${n} ${n === 1 ? "asset uses" : "assets use"} this image. Reassign them first.`,
      );
      return;
    }
    toast.error("Could not delete the image.");
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
        <Pencil className="size-4" />
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void remove()}
        disabled={item.usedBy > 0}
        title={
          item.usedBy > 0
            ? "In use — reassign the assets that use it first"
            : "Delete this image"
        }
      >
        <Trash2 className="size-4" />
        Delete
      </Button>

      {editOpen && (
        <EditMediaDialog
          item={item}
          onOpenChange={(open) => {
            setEditOpen(open);
            if (!open) router.refresh();
          }}
          onSaved={() => {
            setEditOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
