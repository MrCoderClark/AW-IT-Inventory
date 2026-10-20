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

export type ExecuteAssistCoreResult =
  | {
      ok: true;
      result: AssistResult;
      provider: string;
      model: string;
      contextHash: string;
      assetId: string | null;
    }
  | {
      ok: false;
      error: string;
      code: "not_configured" | "not_found" | "provider_error";
      provider: string;
      model: string;
      contextHash: string;
      assetId: string | null;
    };

function coreFailure(
  code: "not_configured" | "not_found" | "provider_error",
  error: string,
  extra?: Partial<
    Pick<
      ExecuteAssistCoreResult,
      "provider" | "model" | "contextHash" | "assetId"
    >
  >,
): ExecuteAssistCoreResult {
  return {
    ok: false,
    code,
    error,
    provider: extra?.provider ?? "",
    model: extra?.model ?? "",
    contextHash: extra?.contextHash ?? "",
    assetId: extra?.assetId ?? null,
  };
}

/**
 * Pack, provider, parse, and audit. Shared by the sync wrapper and the
 * assist job processor. Does not write `ai_assist_jobs` or notify.
 */
export async function executeAssistCore(
  input: RunAssistInput,
): Promise<ExecuteAssistCoreResult> {
  const cfg = loadAiConfig();
  if (!isAiConfigured(cfg)) {
    return coreFailure("not_configured", "AI not configured");
  }

  const pack = await buildComputerContextPack(input.assetTag);
  if (!pack) {
    return coreFailure("not_found", "Computer not found");
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
      return coreFailure("not_found", "jobId required", { assetId });
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
      return coreFailure("not_found", "Script run not found", { assetId });
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
      contextHash,
      assetId,
    };
  } catch (e) {
    const msg =
      e instanceof AiNotConfiguredError
        ? "AI not configured"
        : e instanceof Error
          ? e.message.slice(0, 500)
          : "provider error";
    const model = provider.model || cfg.model || "unknown";
    await recordAssistEvent({
      actorEmail: input.actorEmail,
      assetId,
      action: input.action,
      provider: provider.id,
      model,
      contextHash,
      ok: false,
      error: msg,
    });
    if (e instanceof AiNotConfiguredError) {
      return coreFailure("not_configured", msg, {
        provider: provider.id,
        model,
        contextHash,
        assetId,
      });
    }
    return coreFailure("provider_error", msg, {
      provider: provider.id,
      model,
      contextHash,
      assetId,
    });
  }
}

/** Sync path kept for the current assist route until jobs own it. */
export async function runAssist(
  input: RunAssistInput,
): Promise<RunAssistOutcome> {
  const core = await executeAssistCore(input);
  if (!core.ok) {
    return { ok: false, code: core.code, error: core.error };
  }
  return {
    ok: true,
    result: core.result,
    provider: core.provider,
    model: core.model,
  };
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
