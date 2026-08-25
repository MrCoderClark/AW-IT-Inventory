import { STATUS_META, type AssetStatus } from "@/lib/data";
import { cn } from "@/lib/utils";

export function StatusBadge({
  status,
  className,
}: {
  status: AssetStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn("inline-flex items-center gap-2 text-sm font-medium", className)}
      style={{ color: meta.colorVar }}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: meta.colorVar }}
      />
      {meta.label}
    </span>
  );
}
