import "server-only";

import { and, eq } from "drizzle-orm";

import { isAiConfigured, loadAiConfig } from "@/lib/ai/config";
import { parseAssistResult } from "@/lib/ai/parse";
import { hashContext } from "@/lib/ai/redact";
import {
  AiNotConfiguredError,
  getAiProvider,
} from "@/lib/ai/providers";
import type { AssistAction, AssistResult } from "@/lib/ai/types";

import { buildComputerContextPack } from "./ai-context";
import { db } from "./index";
import { aiAssistEvents, assets, scriptRunJobs } from "./schema";

const JSON_HINT = `{
  "observed": string[],
  "hypotheses": string[],
  "recommendations": string[],
  "scriptDraft"?: { "name"?: string, "body": string, "notes"?: string }
}
Rules: observed = only facts present in the context pack; hypotheses = possible causes (never invent inventory facts); recommendations = next steps for a human technician. For draft_script, include scriptDraft.body as PowerShell without using exit; prefer Write-Output and throw.`;

export type RunAssistInput = {
  action: AssistAction;
  assetTag: string;
  actorEmail: string;
  jobId?: string;
  userPrompt?: string;
};

export type RunAssistOutcome =
  | { ok: true; result: AssistResult; provider: string; model: string }
  | {
      ok: false;
      code: "not_configured" | "not_found" | "provider_error";
      error: string;
    };

export async function runAssist(
  input: RunAssistInput,
): Promise<RunAssistOutcome> {
  const cfg = loadAiConfig();
  if (!isAiConfigured(cfg)) {
    return {
      ok: false,
      code: "not_configured",
      error: "AI not configured",
    };
  }

  const pack = await buildComputerContextPack(input.assetTag);
  if (!pack) {
    return { ok: false, code: "not_found", error: "Computer not found" };
  }

  const [assetRow] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.tag, input.assetTag), eq(assets.type, "Computer")))
    .limit(1);
  const assetId = assetRow?.id ?? null;

  let jobExtra: unknown = null;
  if (input.action === "summarize_script_run") {
    if (!input.jobId || !assetId) {
      return { ok: false, code: "not_found", error: "jobId required" };
    }
    const [job] = await db
      .select({
        id: scriptRunJobs.id,
        status: scriptRunJobs.status,
        result: scriptRunJobs.result,
        error: scriptRunJobs.error,
        snapshot: scriptRunJobs.scriptSnapshot,
      })
      .from(scriptRunJobs)
      .where(
        and(
          eq(scriptRunJobs.id, input.jobId),
          eq(scriptRunJobs.assetId, assetId),
        ),
      )
      .limit(1);
    if (!job) {
      return { ok: false, code: "not_found", error: "Script run not found" };
    }
    jobExtra = {
      id: job.id,
      status: job.status,
      scriptName: job.snapshot.name,
      exitCode: job.result?.exitCode ?? null,
      outputTail: job.result?.outputTail ?? job.error,
    };
  }

  const contextHash = hashContext({ pack, jobExtra, action: input.action });
  const provider = getAiProvider(cfg);

  const system = `You are an IT operations assistant for an on-prem RMM (H2Tecs).
You help technicians. Never claim to have run commands or changed systems.
Separate observed facts (from context) from hypotheses.`;

  const user = [
    `Action: ${input.action}`,
    input.userPrompt?.trim()
      ? `Technician note: ${input.userPrompt.trim()}`
      : null,
    `Context pack (JSON):\n${JSON.stringify({ pack, jobExtra })}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const raw = await provider.complete({
      system,
      user,
      jsonSchemaHint: JSON_HINT,
    });
    const result = parseAssistResult(raw);
    if (input.action !== "draft_script") {
      delete result.scriptDraft;
    }
    await recordAssistEvent({
      actorEmail: input.actorEmail,
      assetId,
      action: input.action,
      provider: provider.id,
      model: provider.model,
      contextHash,
      ok: true,
    });
    return {
      ok: true,
      result,
      provider: provider.id,
      model: provider.model,
    };
  } catch (e) {
    const msg =
      e instanceof AiNotConfiguredError
        ? "AI not configured"
        : e instanceof Error
          ? e.message.slice(0, 500)
          : "provider error";
    await recordAssistEvent({
      actorEmail: input.actorEmail,
      assetId,
      action: input.action,
      provider: provider.id,
      model: provider.model || cfg.model || "unknown",
      contextHash,
      ok: false,
      error: msg,
    });
    if (e instanceof AiNotConfiguredError) {
      return { ok: false, code: "not_configured", error: msg };
    }
    return { ok: false, code: "provider_error", error: msg };
  }
}

/** Best-effort audit — never mask the assist outcome if the table is missing. */
async function recordAssistEvent(row: {
  actorEmail: string;
  assetId: string | null;
  action: string;
  provider: string;
  model: string;
  contextHash: string;
  ok: boolean;
  error?: string;
}): Promise<void> {
  try {
    await db.insert(aiAssistEvents).values(row);
  } catch (e) {
    console.error(
      "[ai-assist] audit write failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

export type { AssistAction, AssistResult };
export { isAiConfigured, loadAiConfig };
