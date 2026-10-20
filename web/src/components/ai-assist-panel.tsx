"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { fmtDateTime, Panel } from "@/components/detail-ui";
import { Button } from "@/components/ui/button";
import type { AssistAction, AssistResult } from "@/lib/ai/types";

export const AI_DRAFT_STORAGE_KEY = "h2tecs-ai-script-draft";

const POLL_MS = 2000;

export type AssistJobStatus = "pending" | "running" | "succeeded" | "failed";

/** Client-safe recent job (timestamps are ISO strings). */
export type AssistJobView = {
  id: string;
  status: AssistJobStatus;
  action: string;
  result: AssistResult | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

const ACTION_LABEL: Record<string, string> = {
  summarize_health: "Summarize health",
  explain_failures: "Explain failures",
  summarize_script_run: "Summarize last script",
  draft_script: "Draft fix script",
};

const STATUS_LABEL: Record<AssistJobStatus, string> = {
  pending: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed";
}

function isAssistStatus(status: unknown): status is AssistJobStatus {
  return (
    status === "pending" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed"
  );
}

function asIso(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

function jobFromPayload(data: {
  id?: unknown;
  status?: unknown;
  action?: unknown;
  result?: AssistResult | null;
  error?: unknown;
  createdAt?: unknown;
  finishedAt?: unknown;
}): AssistJobView | null {
  if (typeof data.id !== "string" || !isAssistStatus(data.status)) return null;
  return {
    id: data.id,
    status: data.status,
    action: typeof data.action === "string" ? data.action : "",
    result: data.result ?? null,
    error: typeof data.error === "string" ? data.error : null,
    createdAt: asIso(data.createdAt) ?? new Date().toISOString(),
    finishedAt: asIso(data.finishedAt),
  };
}

export function AiAssistPanel({
  assetTag,
  canDeploy,
  latestScriptJobId,
  recentJobs = [],
  initialJobId = null,
}: {
  assetTag: string;
  canDeploy: boolean;
  latestScriptJobId?: string | null;
  recentJobs?: AssistJobView[];
  initialJobId?: string | null;
}) {
  const router = useRouter();
  const seeded = recentJobs.find((job) => job.id === initialJobId) ?? null;
  const [busy, setBusy] = React.useState<AssistAction | null>(null);
  const [jobs, setJobs] = React.useState<AssistJobView[]>(recentJobs);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialJobId,
  );
  const [result, setResult] = React.useState<AssistResult | null>(
    seeded?.status === "succeeded" ? seeded.result : null,
  );
  const [panelError, setPanelError] = React.useState<string | null>(
    seeded?.status === "failed" ? seeded.error ?? "Assist failed" : null,
  );
  const [pollingId, setPollingId] = React.useState<string | null>(
    initialJobId && !isTerminal(seeded?.status ?? "") ? initialJobId : null,
  );
  const [prompt, setPrompt] = React.useState("");

  function remember(job: AssistJobView) {
    setJobs((prev) =>
      [job, ...prev.filter((row) => row.id !== job.id)].slice(0, 5),
    );
    setSelectedId(job.id);
    if (job.status === "succeeded") {
      setResult(job.result);
      setPanelError(null);
      setPollingId(null);
      return;
    }
    if (job.status === "failed") {
      setResult(null);
      setPanelError(job.error ?? "Assist failed");
      setPollingId(null);
      return;
    }
    setResult(null);
    setPanelError(null);
  }

  React.useEffect(() => {
    if (!pollingId) return;
    let cancelled = false;

    async function tick() {
      try {
        const res = await fetch(`/api/ai/assist/${pollingId}`);
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => null);
        if (cancelled || !data || typeof data !== "object") return;
        const job = jobFromPayload(data);
        if (!job || cancelled) return;
        remember(job);
      } catch {
        // Keep polling until the panel unmounts or the job finishes.
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // remember is recreated each render; polling restarts only when the id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollingId]);

  async function run(action: AssistAction) {
    setBusy(action);
    try {
      const res = await fetch("/api/ai/assist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          assetTag,
          jobId:
            action === "summarize_script_run"
              ? latestScriptJobId ?? undefined
              : undefined,
          userPrompt: prompt.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) {
        toast.error("AI is not configured on this server.");
        return;
      }
      if (res.status === 202 && typeof data.jobId === "string") {
        toast.message("AI Assist queued");
        const queued: AssistJobView = {
          id: data.jobId,
          status: "pending",
          action,
          result: null,
          error: null,
          createdAt: new Date().toISOString(),
          finishedAt: null,
        };
        setJobs((prev) =>
          [queued, ...prev.filter((row) => row.id !== queued.id)].slice(0, 5),
        );
        setSelectedId(queued.id);
        setResult(null);
        setPanelError(null);
        setPollingId(queued.id);
        return;
      }
      if (!res.ok) {
        toast.error(
          typeof data.error === "string" ? data.error : "Assist failed",
        );
        return;
      }
      toast.error("Assist did not queue");
    } catch {
      toast.error("Assist request failed");
    } finally {
      setBusy(null);
    }
  }

  function selectJob(job: AssistJobView) {
    remember(job);
    if (!isTerminal(job.status)) setPollingId(job.id);
  }

  function openDraftInLibrary() {
    if (!result?.scriptDraft?.body) return;
    try {
      sessionStorage.setItem(
        AI_DRAFT_STORAGE_KEY,
        JSON.stringify({
          name: result.scriptDraft.name ?? `Assist draft — ${assetTag}`,
          body: result.scriptDraft.body,
          notes: result.scriptDraft.notes ?? "",
        }),
      );
    } catch {
      toast.error("Could not store draft locally");
      return;
    }
    router.push("/scripts?aiDraft=1");
  }

  return (
    <Panel icon={<Sparkles />} title="AI Assist">
      <p className="mb-3 text-xs text-muted-foreground">
        Optional help from a configured model. Observed facts come from inventory
        data; hypotheses are guesses. Draft scripts never run until you Save and
        Run them.
      </p>
      <label className="mb-3 block text-xs text-muted-foreground">
        Optional note to the model
        <input
          className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. disk alerts overnight"
        />
      </label>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => run("summarize_health")}
        >
          {busy === "summarize_health" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Summarize health
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => run("explain_failures")}
        >
          {busy === "explain_failures" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Explain failures
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy || !latestScriptJobId}
          onClick={() => run("summarize_script_run")}
          title={
            latestScriptJobId
              ? "Summarize the latest script run"
              : "No script runs yet"
          }
        >
          {busy === "summarize_script_run" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Summarize last script
        </Button>
        {canDeploy && (
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() => run("draft_script")}
          >
            {busy === "draft_script" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Draft fix script
          </Button>
        )}
      </div>

      {jobs.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent
          </h3>
          <ul className="flex flex-col gap-1">
            {jobs.map((job) => {
              const label = actionLabel(job.action);
              const status = STATUS_LABEL[job.status] ?? job.status;
              const when = fmtDateTime(job.createdAt);
              const selected = job.id === selectedId;
              return (
                <li key={job.id}>
                  <button
                    type="button"
                    aria-label={`Recent: ${label}, ${status}, ${when}`}
                    aria-pressed={selected}
                    className={
                      selected
                        ? "flex w-full items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-left text-xs"
                        : "flex w-full items-center justify-between gap-3 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                    }
                    onClick={() => selectJob(job)}
                  >
                    <span className="font-medium">{label}</span>
                    <span className="text-muted-foreground">{status}</span>
                    <time
                      dateTime={job.createdAt}
                      className="shrink-0 tabular-nums text-muted-foreground"
                    >
                      {when}
                    </time>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {pollingId && !result && !panelError && (
        <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Queued. This page checks back until the job finishes.
        </p>
      )}

      {panelError && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {panelError}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-3 text-sm">
          <AssistSection title="Observed" items={result.observed} />
          <AssistSection
            title="Hypotheses"
            items={result.hypotheses}
            muted
          />
          <AssistSection
            title="Suggested next steps"
            items={result.recommendations}
          />
          {result.scriptDraft?.body && canDeploy && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Draft script
                {result.scriptDraft.name
                  ? ` — ${result.scriptDraft.name}`
                  : ""}
              </p>
              {result.scriptDraft.notes && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {result.scriptDraft.notes}
                </p>
              )}
              <pre className="mb-3 max-h-40 overflow-auto rounded-md border bg-background p-2 font-mono text-[11px] whitespace-pre-wrap">
                {result.scriptDraft.body}
              </pre>
              <Button size="sm" onClick={openDraftInLibrary}>
                Open in script editor
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function AssistSection({
  title,
  items,
  muted,
}: {
  title: string;
  items: string[];
  muted?: boolean;
}) {
  if (!items.length) return null;
  return (
    <div>
      <h3
        className={
          muted
            ? "mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400"
            : "mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        }
      >
        {title}
      </h3>
      <ul className="list-disc space-y-1 pl-4 text-sm">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
