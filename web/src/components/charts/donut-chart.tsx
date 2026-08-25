import type { Slice } from "@/lib/data";

export function DonutChart({
  data,
  total,
  totalLabel = "assets",
}: {
  data: Slice[];
  total: number;
  totalLabel?: string;
}) {
  const sum = data.reduce((a, s) => a + s.value, 0);

  // Build a conic-gradient from the slices (var() colors resolve per theme).
  let acc = 0;
  const stops = data
    .map((s) => {
      const start = (acc / sum) * 100;
      acc += s.value;
      const end = (acc / sum) * 100;
      return `${s.colorVar} ${start}% ${end}%`;
    })
    .join(", ");

  return (
    <div className="flex flex-wrap items-center gap-8">
      <div
        role="img"
        aria-label="Asset distribution"
        className="relative size-40 shrink-0 rounded-full"
        style={{ background: `conic-gradient(${stops})` }}
      >
        <div className="absolute inset-[26px] grid place-content-center rounded-full bg-card text-center">
          <span className="text-2xl font-extrabold tabular-nums">
            {total.toLocaleString()}
          </span>
          <span className="text-xs text-muted-foreground">{totalLabel}</span>
        </div>
      </div>
      <ul className="grid flex-1 gap-3 min-w-40">
        {data.map((s) => (
          <li key={s.label} className="flex items-center gap-2.5 text-sm">
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-[4px]"
              style={{ backgroundColor: s.colorVar }}
            />
            {s.label}
            <span className="ml-auto font-semibold text-muted-foreground tabular-nums">
              {Math.round((s.value / sum) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
