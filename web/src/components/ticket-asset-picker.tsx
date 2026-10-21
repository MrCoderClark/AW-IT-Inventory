"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { LinkAsset } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * Searchable asset list for linking a ticket to inventory (spec 33).
 * Same filter pattern as the discovery inbox link picker.
 */
export function TicketAssetPicker({
  assets,
  value,
  onChange,
  disabled,
}: {
  assets: LinkAsset[];
  /** Selected asset id, or null for none. */
  value: string | null;
  onChange: (assetId: string | null) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = React.useState("");
  const needle = q.trim().toLowerCase();

  const results = React.useMemo(() => {
    if (!needle) return [];
    return assets
      .filter((a) =>
        [a.name, a.tag, a.serial, a.type]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, 25);
  }, [assets, needle]);

  const selected = value
    ? assets.find((a) => a.id === value) ?? null
    : null;

  return (
    <div className="grid gap-2">
      {selected ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{selected.name}</p>
            <p className="text-muted-foreground truncate font-mono text-xs">
              {selected.tag}
              {selected.serial ? ` · ${selected.serial}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs font-medium"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            Clear
          </button>
        </div>
      ) : null}

      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, tag, or serial…"
          className="pl-8"
          disabled={disabled}
          aria-label="Search assets"
        />
      </div>

      {!needle ? (
        <p className="text-muted-foreground text-xs">
          Type to search inventory — results appear here.
        </p>
      ) : results.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border px-3 py-4 text-center text-sm">
          No assets match “{q.trim()}”.
        </p>
      ) : (
        <div className="max-h-48 overflow-y-auto rounded-lg border">
          <ul className="flex flex-col p-1">
            {results.map((a) => {
              const active = a.id === value;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onChange(a.id);
                      setQ("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      "hover:bg-accent/50 disabled:opacity-50",
                      active && "bg-primary/10",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{a.name}</p>
                      <p className="text-muted-foreground truncate font-mono text-[11px]">
                        {a.tag}
                        {a.serial ? ` · ${a.serial}` : ""}
                      </p>
                    </div>
                    {active ? (
                      <span className="text-primary text-xs font-medium">
                        Selected
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
