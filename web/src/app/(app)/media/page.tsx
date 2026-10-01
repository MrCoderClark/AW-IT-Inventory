import { Lock } from "lucide-react";

import { MediaLibrary, type MediaLibraryItem } from "@/components/media-library";
import { PagePlaceholder } from "@/components/page-placeholder";
import { listMedia } from "@/db/media";
import { hasPermission, requireUser } from "@/lib/auth/session";

// Usage counts and the library change on upload/assign/delete; read fresh.
export const dynamic = "force-dynamic";

/** Shape a media row (+ usage) into the plain item the client grid renders. */
function toItem(m: Awaited<ReturnType<typeof listMedia>>["items"][number]): MediaLibraryItem {
  return {
    id: m.id,
    name: m.name,
    altText: m.altText,
    notes: m.notes,
    contentType: m.contentType,
    sizeBytes: m.sizeBytes,
    width: m.width,
    height: m.height,
    usedBy: m.usedBy,
    thumbUrl: `/api/media/${m.id}?variant=thumb`,
  };
}

export default async function Page() {
  const user = await requireUser();

  // Viewing is open to any asset:read user (spec 18, AC-5); managing needs write.
  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Media"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const canWrite = hasPermission(user, "asset:write");
  const page = await listMedia();

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Media</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The shared image library. Upload a photo once and reuse it across any
          number of identical assets. Each image shows how many assets use it.
        </p>
      </div>

      <MediaLibrary
        initialItems={page.items.map(toItem)}
        initialCursor={page.nextCursor}
        canWrite={canWrite}
      />
    </div>
  );
}
