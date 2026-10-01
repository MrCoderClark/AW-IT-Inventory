import { Lock } from "lucide-react";

import {
  MediaLibrary,
  type MediaLibraryItem,
} from "@/components/media-library";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getMediaStats, listMedia } from "@/db/media";
import { hasPermission, requireUser } from "@/lib/auth/session";

// Usage counts and the library change on upload/assign/delete; read fresh.
export const dynamic = "force-dynamic";

/** Shape a media row (+ usage) into the plain item the client grid renders. */
function toItem(
  m: Awaited<ReturnType<typeof listMedia>>["items"][number],
): MediaLibraryItem {
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
  const [page, stats] = await Promise.all([listMedia(), getMediaStats()]);

  return (
    <div className="mx-auto w-full max-w-[1280px]">
      <MediaLibrary
        initialItems={page.items.map(toItem)}
        initialNextOffset={page.nextOffset}
        stats={stats}
        canWrite={canWrite}
      />
    </div>
  );
}
