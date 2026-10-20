"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { ScriptRunResult } from "@/db/schema";

/** Collapsible host output for a finished (or failed) script run. */
export function ScriptRunOutput({
  result,
  error,
  defaultOpen = true,
}: {
  result: ScriptRunResult | null | undefined;
  error?: string | null;
  defaultOpen?: boolean;
}) {
  const tail = (result?.outputTail ?? "").trim();
  const hasBody = Boolean(tail || error);
  const [open, setOpen] = React.useState(defaultOpen && hasBody);

  if (!hasBody) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        No output captured from the host.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        Output
        {result?.exitCode != null ? ` · exit ${result.exitCode}` : ""}
      </button>
      {open && (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
          {error ? `error: ${error}\n` : ""}
          {tail || "(empty)"}
        </pre>
      )}
    </div>
  );
}
