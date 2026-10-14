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
import {
  deleteSchedule,
  upsertSchedule,
  type SavedSchedule,
} from "@/db/report-schedules";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { validateScheduleInput } from "@/lib/report-schedule";
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

/* ----------------------------- schedules (phase 2) ----------------------------- */

export type SaveScheduleResult =
  | { ok: true; schedule: SavedSchedule; message: string }
  | { ok: false; error: string };

/** Create or replace a saved report's delivery schedule. `report:write`. */
export async function saveScheduleAction(input: {
  reportId: unknown;
  enabled?: unknown;
  schedule: unknown;
}): Promise<SaveScheduleResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "report:write")) {
    return { ok: false, error: "You don't have permission to schedule reports." };
  }
  if (typeof input.reportId !== "string" || !input.reportId) {
    return { ok: false, error: "Unknown report." };
  }
  const report = await getReport(input.reportId);
  if (!report) return { ok: false, error: "That report no longer exists." };

  const check = validateScheduleInput(input.schedule);
  if (!check.ok) return { ok: false, error: check.error };

  const schedule = await upsertSchedule(input.reportId, check.input, {
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    createdBy: user?.email ?? null,
  });
  revalidatePath("/reports");
  revalidatePath(`/reports/custom/${input.reportId}`);
  return {
    ok: true,
    schedule,
    message: schedule.enabled ? "Delivery scheduled." : "Schedule saved (paused).",
  };
}

/** Remove a report's delivery schedule. `report:write`. */
export async function deleteScheduleAction(
  reportId: unknown,
): Promise<SaveReportResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "report:write")) {
    return { ok: false, error: "You don't have permission to schedule reports." };
  }
  if (typeof reportId !== "string" || !reportId) {
    return { ok: false, error: "Unknown report." };
  }
  const removed = await deleteSchedule(reportId);
  if (!removed) return { ok: false, error: "There was no schedule to remove." };
  revalidatePath("/reports");
  revalidatePath(`/reports/custom/${reportId}`);
  return { ok: true, id: reportId, message: "Delivery schedule removed." };
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
