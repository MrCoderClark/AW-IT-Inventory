import type { LucideIcon } from "lucide-react";

export function PagePlaceholder({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
      <div className="grid place-content-center gap-3 rounded-xl border border-dashed bg-card/50 py-24 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent text-primary">
          <Icon className="size-7" />
        </span>
        <p className="text-lg font-semibold">{title}</p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}
