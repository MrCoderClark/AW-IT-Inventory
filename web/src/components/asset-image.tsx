import { TYPE_ICON, type AssetType } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * An asset's product photo, or the type icon when it has none (spec 17.02,
 * AC-2.2). Presentational and server-safe: the image is just an `<img>` pointing
 * at the authenticated GET route, so no broken image ever shows (a null
 * `imageKey` renders the icon instead). The `?v=<imageKey>` busts the browser
 * cache when the image is replaced (the key changes on every upload).
 */
export function AssetImage({
  tag,
  imageKey,
  type,
  alt = "",
  className,
  iconClassName,
}: {
  tag: string;
  imageKey?: string | null;
  type: AssetType;
  /** Accessible name for a meaningful image; leave empty for a decorative one. */
  alt?: string;
  className?: string;
  iconClassName?: string;
}) {
  if (imageKey) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- streamed from our
      // own private route, not an optimizable static/remote asset.
      <img
        src={`/api/assets/${encodeURIComponent(tag)}/image?v=${encodeURIComponent(imageKey)}`}
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
