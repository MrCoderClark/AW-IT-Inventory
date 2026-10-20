"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Panel } from "@/components/detail-ui";
import { Button } from "@/components/ui/button";
import type { AssistAction, AssistResult } from "@/lib/ai/types";

export const AI_DRAFT_STORAGE_KEY = "h2tecs-ai-script-draft";

export function AiAssistPanel({
  assetTag,
  canDeploy,
  latestScriptJobId,
}: {
  assetTag: string;
  canDeploy: boolean;
  latestScriptJobId?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<AssistAction | null>(null);
  const [result, setResult] = React.useState<AssistResult | null>(null);
  const [prompt, setPrompt] = React.useState("");

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
      if (!res.ok) {
        toast.error(
          typeof data.error === "string" ? data.error : "Assist failed",
        );
        return;
      }
      setResult(data.result as AssistResult);
    } catch {
      toast.error("Assist request failed");
    } finally {
      setBusy(null);
    }
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
