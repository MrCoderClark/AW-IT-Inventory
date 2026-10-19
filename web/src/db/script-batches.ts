import "server-only";

import { desc, eq } from "drizzle-orm";

import { db } from "./index";
import { enqueueScriptRun } from "./script-runs";
import { resolveScriptTargets } from "./script-targets";
import {
  scriptRunBatches,
  type ScriptSnapshot,
  type ScriptTargetSpec,
} from "./schema";

export type EnqueueBatchInput = {
  scriptId: string;
  scriptSnapshot: ScriptSnapshot;
  targetSpec: ScriptTargetSpec;
  source: "manual" | "schedule";
  scheduleId?: string | null;
  requestedBy: string;
};

export type EnqueueBatchResult = {
  batchId: string;
  enqueued: number;
  skippedNoIp: number;
  skippedInflight: number;
};

/**
 * Materialize a fan-out run (spec 32 v2): one batch row + one job per host that
 * has an IP and is not already in-flight. Soft-skips in-flight hosts.
 */
export async function enqueueScriptBatch(
  input: EnqueueBatchInput,
): Promise<EnqueueBatchResult> {
  const { resolved, skippedNoIp } = await resolveScriptTargets(input.targetSpec);

  const [batch] = await db
    .insert(scriptRunBatches)
    .values({
      scriptId: input.scriptId,
      scriptSnapshot: input.scriptSnapshot,
      targetSpec: input.targetSpec,
      source: input.source,
      scheduleId: input.scheduleId ?? null,
      requestedBy: input.requestedBy,
      enqueuedCount: 0,
      skippedCount: skippedNoIp,
    })
    .returning({ id: scriptRunBatches.id });

  let enqueued = 0;
  let skippedInflight = 0;
  for (const t of resolved) {
    const res = await enqueueScriptRun({
      assetId: t.assetId,
      targetIp: t.ip,
      scriptId: input.scriptId,
      scriptSnapshot: input.scriptSnapshot,
      requestedBy: input.requestedBy,
      batchId: batch.id,
    });
    if (res.ok) enqueued += 1;
    else skippedInflight += 1;
  }

  const skippedCount = skippedNoIp + skippedInflight;
  await db
    .update(scriptRunBatches)
    .set({ enqueuedCount: enqueued, skippedCount })
    .where(eq(scriptRunBatches.id, batch.id));

  return {
    batchId: batch.id,
    enqueued,
    skippedNoIp,
    skippedInflight,
  };
}

export type ScriptBatchListItem = {
  id: string;
  scriptName: string;
  source: "manual" | "schedule";
  enqueuedCount: number;
  skippedCount: number;
  requestedBy: string;
  createdAt: string;
};

export async function listRecentBatches(
  limit = 20,
): Promise<ScriptBatchListItem[]> {
  const rows = await db
    .select({
      id: scriptRunBatches.id,
      snapshot: scriptRunBatches.scriptSnapshot,
      source: scriptRunBatches.source,
      enqueuedCount: scriptRunBatches.enqueuedCount,
      skippedCount: scriptRunBatches.skippedCount,
      requestedBy: scriptRunBatches.requestedBy,
      createdAt: scriptRunBatches.createdAt,
    })
    .from(scriptRunBatches)
    .orderBy(desc(scriptRunBatches.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    scriptName: r.snapshot.name,
    source: r.source,
    enqueuedCount: r.enqueuedCount,
    skippedCount: r.skippedCount,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt.toISOString(),
  }));
}
