"use server";

import { revalidatePath } from "next/cache";

import {
  createReport,
  deleteReport,
  getReport,
  runReportBySpec,
  updateReport,
  validateSpec,
} from "@/db/report-engine";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ReportResult, ReportSpec } from "@/lib/report-spec";

/* Server actions behind the custom report builder (spec 26, slice 1b). Running +
   previewing a report needs `report:read`; saving/deleting a shared definition
   needs `report:write`. Both gates are rechecked here (the UI only hides the
   controls), and the spec is re-validated against the whitelisted field catalog
   before it ever touches the engine — no user SQL reaches the database. */

export type RunReportResult =
  | { ok: true; result: ReportResult }
  | { ok: false; error: string };

export type SaveReportResult =
  | { ok: true; id: string; message: string }
  | { ok: false; error: string };

/** Run a spec and return its result for the live preview. `report:read`. */
export async function runReportAction(
  source: unknown,
  spec: unknown,
): Promise<RunReportResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "report:read")) {
    return { ok: false, error: "You don't have permission to run reports." };
  }
  if (typeof source !== "string") {
    return { ok: false, error: "Pick a data source." };
  }

  const check = validateSpec(source, spec as ReportSpec);
  if (!check.ok) return { ok: false, error: check.error };

  try {
    const result = await runReportBySpec(check.spec);
    return { ok: true, result };
  } catch {
    return { ok: false, error: "Could not run that report. Check the fields and try again." };
  }
}

/** Create a new saved report, or update an existing one when `id` is given.
   `report:write`. */
export async function saveReportAction(input: {
  id?: string | null;
  name: unknown;
  description?: unknown;
  source: unknown;
  spec: unknown;
}): Promise<SaveReportResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "report:write")) {
    return { ok: false, error: "You don't have permission to save reports." };
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the report a name." };
  if (name.length > 120) {
    return { ok: false, error: "That name is too long (120 characters max)." };
  }

  if (typeof input.source !== "string") {
    return { ok: false, error: "Pick a data source." };
  }
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : null;

  const check = validateSpec(input.source, input.spec as ReportSpec);
  if (!check.ok) return { ok: false, error: check.error };

  if (input.id) {
    const existing = await getReport(input.id);
    if (!existing) return { ok: false, error: "That report no longer exists." };
    const updated = await updateReport(input.id, {
      name,
      description,
      source: input.source,
      spec: check.spec,
    });
    if (!updated) return { ok: false, error: "That report no longer exists." };
    revalidatePath("/reports");
    revalidatePath(`/reports/custom/${input.id}`);
    return { ok: true, id: updated.id, message: `Saved "${name}".` };
  }

  const created = await createReport({
    name,
    description,
    source: input.source,
    spec: check.spec,
    createdBy: user?.email ?? null,
  });
  revalidatePath("/reports");
  return { ok: true, id: created.id, message: `Saved "${name}".` };
}

/** Delete a saved report. `report:write`. */
export async function deleteReportAction(id: unknown): Promise<SaveReportResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "report:write")) {
    return { ok: false, error: "You don't have permission to delete reports." };
  }
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown report." };
  }
  const removed = await deleteReport(id);
  if (!removed) return { ok: false, error: "That report no longer exists." };
  revalidatePath("/reports");
  return { ok: true, id, message: "Report deleted." };
}
