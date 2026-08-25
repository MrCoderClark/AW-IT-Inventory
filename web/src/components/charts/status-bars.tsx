export function StatusBars({
  data,
}: {
  data: { label: string; pct: number; colorVar: string }[];
}) {
  return (
    <div className="grid gap-5">
      {data.map((row) => (
        <div key={row.label}>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>{row.label}</span>
            <span className="font-bold tabular-nums">{row.pct}%</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{ width: `${row.pct}%`, backgroundColor: row.colorVar }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
