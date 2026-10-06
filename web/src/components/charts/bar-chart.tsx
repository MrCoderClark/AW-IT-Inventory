/**
 * A small vertical bar chart for categorical counts (e.g. assets by type), styled
 * to the OPUS design system. Pure/server-safe. Follows the dataviz mark specs:
 * thin bars with 4px-rounded data-ends anchored to the baseline, recessive
 * gridlines, a direct value label above each bar (so no legend/hover is needed for
 * a handful of bars), and each bar carries a native title for hover/accessibility.
 * Color follows the entity (the caller passes a fixed per-category color).
 */
export function BarChart({
  data,
  height = 220,
  ticks = 4,
}: {
  data: { label: string; value: number; colorVar: string }[];
  height?: number;
  ticks?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  // A rounded "nice" top so the gridline labels read cleanly.
  const step = niceStep(max / ticks);
  const top = step * ticks;
  const gridLines = Array.from({ length: ticks + 1 }, (_, i) => top - i * step);

  return (
    <div className="flex gap-3">
      {/* Y axis ticks */}
      <div
        className="flex shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-muted-foreground"
        style={{ height }}
        aria-hidden
      >
        {gridLines.map((v) => (
          <span key={v}>{v.toLocaleString()}</span>
        ))}
      </div>

      {/* Plot */}
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height }}>
          {/* Gridlines */}
          {gridLines.map((v, i) => (
            <div
              key={v}
              aria-hidden
              className="absolute inset-x-0 border-t border-border/60"
              style={{ top: `${(i / ticks) * 100}%` }}
            />
          ))}
          {/* Bars */}
          <div className="absolute inset-0 flex items-end justify-around gap-3">
            {data.map((d) => (
              <div
                key={d.label}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                title={`${d.label}: ${d.value.toLocaleString()}`}
              >
                <span className="mb-1 text-xs font-semibold tabular-nums">
                  {d.value.toLocaleString()}
                </span>
                <div
                  className="w-full max-w-14 rounded-t-[4px]"
                  style={{
                    height: `${(d.value / top) * 100}%`,
                    backgroundColor: d.colorVar,
                  }}
                />
              </div>
            ))}
          </div>
        </div>
        {/* X labels */}
        <div className="mt-2 flex justify-around gap-3 text-center text-xs text-muted-foreground">
          {data.map((d) => (
            <span key={d.label} className="min-w-0 flex-1 truncate">
              {d.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Round a raw step up to a clean 1/2/5 × 10ⁿ value, so axis ticks are legible. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}
