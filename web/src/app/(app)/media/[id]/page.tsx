import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Lock } from "lucide-react";

import { MediaCutoutControl, type CutoutUiStatus } from "@/components/media-cutout-control";
import { MediaDetailActions } from "@/components/media-detail-actions";
import { PagePlaceholder } from "@/components/page-placeholder";
import { getMediaDetail } from "@/db/media";
import { TYPE_ICON, type AssetType } from "@/lib/data";
import { hasPermission, requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function typeLabel(contentType: string): string {
  const sub = contentType.split("/")[1]?.toUpperCase() ?? "IMG";
  return sub === "JPEG" ? "JPG" : sub;
}
function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function formatDate(d: Date): string {
  return new Date(d).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-medium">{value}</span>
    </div>
  );
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, "asset:read")) {
    return (
      <PagePlaceholder
        title="Media"
        description="You don't have permission to view assets. Ask an admin for the asset:read role."
        icon={Lock}
      />
    );
  }

  const { id } = await params;
  const media = await getMediaDetail(id);
  if (!media) notFound();

  const canWrite = hasPermission(user, "asset:write");
  const dims = media.width && media.height ? `${media.width} × ${media.height}` : "—";

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/media" className="hover:text-foreground">
          Media
        </Link>
        <ChevronRight className="size-4" />
        <span className="font-medium text-foreground">{media.name}</span>
      </nav>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* Preview */}
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-xl border bg-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- private route */}
            <img
              src={`/api/media/${media.id}?variant=original`}
              alt={media.altText ?? media.name}
              className="aspect-[4/3] w-full bg-accent-soft object-contain"
            />
          </div>
          <MediaCutoutControl
            mediaId={media.id}
            status={(media.cutoutStatus ?? "none") as CutoutUiStatus}
            hasCutout={!!media.cutoutKey}
            canWrite={canWrite}
            version={media.cutoutAttempts ?? 0}
          />
        </div>

        {/* Details */}
        <div className="flex flex-col gap-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-heading text-2xl font-bold tracking-tight">
                {media.name}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {typeLabel(media.contentType)} · {fileSize(media.sizeBytes)} · used by{" "}
                {media.usedBy} {media.usedBy === 1 ? "asset" : "assets"}
              </p>
            </div>
            {canWrite && (
              <MediaDetailActions
                item={{
                  id: media.id,
                  name: media.name,
                  altText: media.altText,
                  notes: media.notes,
                  contentType: media.contentType,
                  sizeBytes: media.sizeBytes,
                  width: media.width,
                  height: media.height,
                  usedBy: media.usedBy,
                  thumbUrl: `/api/media/${media.id}?variant=thumb`,
                }}
              />
            )}
          </div>

          <section className="rounded-xl border bg-card px-4 py-2">
            <h2 className="py-2 text-sm font-semibold">Details</h2>
            <div className="divide-y">
              <Row label="Name" value={media.name} />
              <Row label="File type" value={typeLabel(media.contentType)} />
              <Row label="File size" value={fileSize(media.sizeBytes)} />
              <Row label="Dimensions" value={dims} />
              <Row label="Uploaded" value={formatDate(media.createdAt)} />
              <Row label="Uploaded by" value={media.createdBy ?? "—"} />
            </div>
          </section>

          <section className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">
              Used in Assets ({media.usedBy})
            </h2>
            {media.assets.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Not used by any asset yet. Assign it from an asset&apos;s photo control.
              </p>
            ) : (
              <ul className="divide-y">
                {media.assets.map((a) => {
                  const Icon = TYPE_ICON[a.type as AssetType];
                  return (
                    <li key={a.tag}>
                      <Link
                        href={`/assets/${a.tag}`}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-primary">
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {a.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {a.type}
                          </span>
                        </span>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {media.notes && (
            <section className="rounded-xl border bg-card px-4 py-3">
              <h2 className="text-sm font-semibold">Notes</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{media.notes}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
