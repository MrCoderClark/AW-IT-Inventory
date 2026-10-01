import { TYPE_ICON, type AssetType } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * An asset's product photo, or the type icon when it has none (spec 18, AC-7,
 * superseding spec 17.02). Presentational and server-safe: the image is just an
 * `<img>` pointing at the authenticated GET route, so no broken image ever shows
 * (a null `imageId` renders the icon instead). The `?v=<imageId>` busts the browser
 * cache when the asset is repointed at a different library image.
 */
export function AssetImage({
  tag,
  imageId,
  type,
  alt = "",
  className,
  iconClassName,
}: {
  tag: string;
  imageId?: string | null;
  type: AssetType;
  /** Accessible name for a meaningful image; leave empty for a decorative one. */
  alt?: string;
  className?: string;
  iconClassName?: string;
}) {
  if (imageId) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- streamed from our
      // own private route, not an optimizable static/remote asset.
      <img
        src={`/api/assets/${encodeURIComponent(tag)}/image?v=${encodeURIComponent(imageId)}`}
        alt={alt}
        className={cn("object-cover", className)}
      />
    );
  }
  const Icon = TYPE_ICON[type];
  return (
    <span
      aria-hidden
      className={cn(
        "grid place-items-center bg-accent-soft text-primary",
        className,
      )}
    >
      <Icon className={cn("size-1/2", iconClassName)} />
    </span>
  );
}
