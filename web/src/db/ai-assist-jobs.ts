import "server-only";

import { and, desc, eq, inArray, lt } from "drizzle-orm";

import { isAiConfigured } from "@/lib/ai/config";
import type { AssistAction, AssistResult } from "@/lib/ai/types";

import { executeAssistCore, type ExecuteAssistCoreResult } from "./ai-assist";
import { db } from "./index";
import { notifyAiAssistResult } from "./notifications";
import { aiAssistJobs, assets, type AiAssistJobRow } from "./schema";

/** A running assist job older than this is failed and the requester is told. */
export const STUCK_MS = 10 * 60 * 1000;

const INTERRUPTED_ERROR =
  "Assist interrupted (timed out or server restarted)";

const ERROR_MAX = 500;

const OPEN_STATUSES = ["pending", "running"] as const;

export type EnqueueAssistJobInput = {
  action: AssistAction;
  assetTag: string;
  actorEmail: string;
  scriptRunJobId?: string;
  userPrompt?: string;
};

export type EnqueueAssistJobResult =
  | { id: string }
  | { error: "not_configured" | "not_found" };

export type AssistJobListRow = {
  id: string;
  status: AiAssistJobRow["status"];
  action: string;
  result: AssistResult | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  actorEmail: string;
  assetId: string | null;
};

type LoadedJob = {
  id: string;
  actorEmail: string;
  assetId: string | null;
  action: string;
  scriptRunJobId: string | null;
  userPrompt: string | null;
  status: AiAssistJobRow["status"];
  assetTag: string | null;
};

function clipError(error: string): string {
  return error.slice(0, ERROR_MAX);
}

function isTerminal(status: AiAssistJobRow["status"]): boolean {
  return status === "succeeded" || status === "failed";
}

async function loadJob(jobId: string): Promise<LoadedJob | null> {
  const [job] = await db
    .select({
      id: aiAssistJobs.id,
      actorEmail: aiAssistJobs.actorEmail,
      assetId: aiAssistJobs.assetId,
      action: aiAssistJobs.action,
      scriptRunJobId: aiAssistJobs.scriptRunJobId,
      userPrompt: aiAssistJobs.userPrompt,
      status: aiAssistJobs.status,
      assetTag: assets.tag,
    })
    .from(aiAssistJobs)
    .leftJoin(assets, eq(aiAssistJobs.assetId, assets.id))
    .where(eq(aiAssistJobs.id, jobId))
    .limit(1);
  return job ?? null;
}

/**
 * Insert a pending assist job. Reclaims stuck running jobs first.
 * Does not notify — the requester is told only when the job reaches a
 * terminal state.
 */
export async function enqueueAssistJob(
  input: EnqueueAssistJobInput,
): Promise<EnqueueAssistJobResult> {
  await reclaimStuckAssistJobs();
  if (!isAiConfigured()) return { error: "not_configured" };

  const [assetRow] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.tag, input.assetTag), eq(assets.type, "Computer")))
    .limit(1);
  if (!assetRow) return { error: "not_found" };

  const [row] = await db
    .insert(aiAssistJobs)
    .values({
      actorEmail: input.actorEmail,
      assetId: assetRow.id,
      action: input.action,
      scriptRunJobId: input.scriptRunJobId ?? null,
      userPrompt: input.userPrompt ?? null,
      status: "pending",
    })
    .returning({ id: aiAssistJobs.id });
  if (!row) throw new Error("assist job insert returned no id");
  return { id: row.id };
}

/**
 * Run one assist job to a terminal state and notify the requester.
 * Swallows errors so a Next.js `after()` callback cannot fail the request.
 */
export async function processAssistJob(jobId: string): Promise<void> {
  try {
    const job = await loadJob(jobId);
    if (!job || isTerminal(job.status)) return;

    await db
      .update(aiAssistJobs)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(aiAssistJobs.id, jobId),
          inArray(aiAssistJobs.status, [...OPEN_STATUSES]),
        ),
      );

    const outcome = await runCore(job);
    const wrote = await writeTerminal(jobId, outcome);
    if (!wrote) return;
    await safeNotify(
      job,
      outcome.ok,
      outcome.ok ? undefined : clipError(outcome.error || "provider error"),
    );
  } catch (e) {
    console.error(
      "[ai-assist-jobs] process failed:",
      e instanceof Error ? e.message : e,
    );
    try {
      await failUnexpected(jobId, e);
    } catch (inner) {
      console.error(
        "[ai-assist-jobs] failed to record failure:",
        inner instanceof Error ? inner.message : inner,
      );
    }
  }
}

async function runCore(job: LoadedJob): Promise<ExecuteAssistCoreResult> {
  try {
    return await executeAssistCore({
      action: job.action as AssistAction,
      assetTag: job.assetTag ?? "",
      actorEmail: job.actorEmail,
      // script_run_job_id is the summarize_script_run job id the core expects.
      jobId: job.scriptRunJobId ?? undefined,
      userPrompt: job.userPrompt ?? undefined,
    });
  } catch (e) {
    const error = clipError(
      e instanceof Error ? e.message : "provider error",
    );
    return {
      ok: false,
      code: "provider_error",
      error,
      provider: "",
      model: "",
      contextHash: "",
      assetId: job.assetId,
    };
  }
}

/** Returns false when the row was already terminal (for example reclaimed). */
async function writeTerminal(
  jobId: string,
  outcome: ExecuteAssistCoreResult,
): Promise<boolean> {
  const finishedAt = new Date();
  const patch = outcome.ok
    ? {
        status: "succeeded" as const,
        result: outcome.result,
        error: null,
        contextHash: outcome.contextHash || null,
        provider: outcome.provider || null,
        model: outcome.model || null,
        finishedAt,
      }
    : {
        status: "failed" as const,
        error: clipError(outcome.error || "provider error"),
        contextHash: outcome.contextHash || null,
        provider: outcome.provider || null,
        model: outcome.model || null,
        finishedAt,
      };
  const rows = await db
    .update(aiAssistJobs)
    .set(patch)
    .where(
      and(
        eq(aiAssistJobs.id, jobId),
        inArray(aiAssistJobs.status, [...OPEN_STATUSES]),
      ),
    )
    .returning({ id: aiAssistJobs.id });
  return rows.length > 0;
}

async function failUnexpected(jobId: string, e: unknown): Promise<void> {
  const job = await loadJob(jobId);
  if (!job || isTerminal(job.status)) return;
  const error = clipError(
    e instanceof Error ? e.message : "provider error",
  );
  const wrote = await writeTerminal(jobId, {
    ok: false,
    code: "provider_error",
    error,
    provider: "",
    model: "",
    contextHash: "",
    assetId: job.assetId,
  });
  if (!wrote) return;
  await safeNotify(job, false, error);
}

async function safeNotify(
  job: LoadedJob,
  ok: boolean,
  error?: string,
): Promise<void> {
  try {
    const notificationId = await notifyAiAssistResult({
      jobId: job.id,
      actorEmail: job.actorEmail,
      assetTag: job.assetTag ?? "",
      assetId: job.assetId,
      action: job.action,
      ok,
      error,
    });
    if (!notificationId) return;
    await db
      .update(aiAssistJobs)
      .set({ notificationId })
      .where(eq(aiAssistJobs.id, job.id));
  } catch (e) {
    console.error(
      "[ai-assist-jobs] notify failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Fail running jobs whose `startedAt` is older than `olderThanMs` and notify
 * each requester. Returns how many rows this call moved to failed.
 */
export async function reclaimStuckAssistJobs(
  olderThanMs = STUCK_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stuck = await db
    .select({
      id: aiAssistJobs.id,
      actorEmail: aiAssistJobs.actorEmail,
      assetId: aiAssistJobs.assetId,
      action: aiAssistJobs.action,
      tag: assets.tag,
    })
    .from(aiAssistJobs)
    .leftJoin(assets, eq(aiAssistJobs.assetId, assets.id))
    .where(
      and(eq(aiAssistJobs.status, "running"), lt(aiAssistJobs.startedAt, cutoff)),
    );

  let reclaimed = 0;
  for (const job of stuck) {
    const rows = await db
      .update(aiAssistJobs)
      .set({
        status: "failed",
        error: INTERRUPTED_ERROR,
        finishedAt: new Date(),
      })
      .where(
        and(eq(aiAssistJobs.id, job.id), eq(aiAssistJobs.status, "running")),
      )
      .returning({ id: aiAssistJobs.id });
    if (rows.length === 0) continue;
    reclaimed += 1;
    await safeNotify(
      {
        id: job.id,
        actorEmail: job.actorEmail,
        assetId: job.assetId,
        action: job.action,
        scriptRunJobId: null,
        userPrompt: null,
        status: "failed",
        assetTag: job.tag,
      },
      false,
      INTERRUPTED_ERROR,
    );
  }
  return reclaimed;
}

export async function getAssistJob(
  jobId: string,
): Promise<AiAssistJobRow | null> {
  const [row] = await db
    .select()
    .from(aiAssistJobs)
    .where(eq(aiAssistJobs.id, jobId))
    .limit(1);
  return row ?? null;
}

/** Newest jobs for an asset tag. Authorization stays in the route. */
export async function listAssistJobsForAssetTag(
  tag: string,
  limit = 5,
): Promise<AssistJobListRow[]> {
  return db
    .select({
      id: aiAssistJobs.id,
      status: aiAssistJobs.status,
      action: aiAssistJobs.action,
      result: aiAssistJobs.result,
      error: aiAssistJobs.error,
      createdAt: aiAssistJobs.createdAt,
      finishedAt: aiAssistJobs.finishedAt,
      actorEmail: aiAssistJobs.actorEmail,
      assetId: aiAssistJobs.assetId,
    })
    .from(aiAssistJobs)
    .innerJoin(assets, eq(aiAssistJobs.assetId, assets.id))
    .where(eq(assets.tag, tag))
    .orderBy(desc(aiAssistJobs.createdAt))
    .limit(limit);
}
