"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, Scissors } from "lucide-react";
import { toast } from "sonner";

import { requestCutoutAction } from "@/app/(app)/media-actions";
import { Button } from "@/components/ui/button";

export type CutoutUiStatus = "none" | "pending" | "processing" | "done" | "failed";

function statusLabel(s: CutoutUiStatus): string {
  switch (s) {
    case "pending":
      return "Queued — waiting for the cut-out worker…";
    case "processing":
      return "Removing the background…";
    case "done":
      return "Done — transparent cut-out ready.";
    case "failed":
      return "Last attempt failed. Retry when ready.";
    default:
      return "Create a transparent, background-removed version (runs on a self-hosted worker).";
  }
}

/**
 * Background-removal control on the media detail page (spec 18 phase 3, AC-9).
 * Requests a cut-out job, shows its status, and — while a job runs — auto-refreshes
 * the page so the result appears without a manual reload. A failed job is retryable.
 */
export function MediaCutoutControl({
  mediaId,
  status,
  hasCutout,
  canWrite,
}: {
  mediaId: string;
  status: CutoutUiStatus;
  hasCutout: boolean;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const running = status === "pending" || status === "processing";

  // Poll while a job runs: re-render the server component for fresh status/result.
  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [running, router]);

  async function request() {
    setBusy(true);
    try {
      const res = await requestCutoutAction(mediaId);
      if (res.ok) {
        toast.success(res.message ?? "Queued.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setBusy(false);
    }
  }

  const showButton =
    canWrite && (status === "none" || status === "done" || status === "failed");

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-(--radius-control) bg-accent-soft text-primary">
            <Scissors className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Background removal</h2>
            <p className="text-xs text-muted-foreground">{statusLabel(status)}</p>
          </div>
        </div>

        {running ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Processing…
          </span>
        ) : (
          showButton && (
            <Button
              variant={status === "done" ? "outline" : "default"}
              size="sm"
              onClick={() => void request()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : status === "done" || status === "failed" ? (
                <RotateCcw className="size-4" />
              ) : (
                <Scissors className="size-4" />
              )}
              {status === "done" ? "Redo" : status === "failed" ? "Retry" : "Remove background"}
            </Button>
          )
        )}
      </div>

      {hasCutout && status === "done" && (
        <div
          className="mt-3 grid place-items-center overflow-hidden rounded-lg border p-2"
          // Checkerboard so the transparency reads clearly.
          style={{
            backgroundImage:
              "repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%)",
            backgroundSize: "16px 16px",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- private route */}
          <img
            src={`/api/media/${mediaId}?variant=cutout`}
            alt="Background-removed cut-out"
            className="max-h-64 w-auto object-contain"
          />
        </div>
      )}
    </section>
  );
}
