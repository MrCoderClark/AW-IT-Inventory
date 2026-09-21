"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/index";
import { tableColumnConfig } from "@/db/schema";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import {
  isColumnView,
  sanitizeColumns,
  type ColumnView,
} from "@/lib/table-columns";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to configure columns.",
};

const BAD_VIEW: ActionResult = {
  ok: false,
  error: "That table view doesn't exist.",
};

/** The route to revalidate for each view, so the global layout change reaches
   every user on their next load (AC-5). Location is a dynamic route. */
function revalidateView(view: ColumnView) {
  const routes: Record<ColumnView, () => void> = {
    computer: () => revalidatePath("/computers"),
    monitor: () => revalidatePath("/monitors"),
    printer: () => revalidatePath("/printers"),
    phone: () => revalidatePath("/phones"),
    network: () => revalidatePath("/network"),
    dashboard: () => revalidatePath("/dashboard"),
    location: () => revalidatePath("/locations/[id]", "page"),
  };
  routes[view]();
}

/** Gate every column mutation on `columns:write`, server-side (AC-4, AC-8). */
async function requireColumnsWrite(): Promise<boolean> {
  const user = await getCurrentUser();
  return hasPermission(user, "columns:write");
}

/**
 * Save the chosen ordered visible column ids for a view (AC-5). The submitted
 * ids are re-validated against the view's catalog before writing (ids outside
 * it dropped, locked columns forced, Name + Actions always present), so stored
 * data can't drift from what the code can render (AC-6). Upsert by primary key,
 * last write wins.
 */
export async function saveColumnConfig(
  view: unknown,
  ids: unknown,
): Promise<ActionResult> {
  if (!(await requireColumnsWrite())) return FORBIDDEN;
  if (!isColumnView(view)) return BAD_VIEW;

  const columns = sanitizeColumns(view, ids);

  await db
    .insert(tableColumnConfig)
    .values({ viewKey: view, columns, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: tableColumnConfig.viewKey,
      set: { columns, updatedAt: new Date() },
    });

  revalidateView(view);
  return { ok: true, message: "Column layout saved for everyone." };
}

/**
 * Reset a view to the code defaults by deleting its saved row (AC-5). With no
 * row, the table falls back to today's hardcoded columns.
 */
export async function resetColumnConfig(view: unknown): Promise<ActionResult> {
  if (!(await requireColumnsWrite())) return FORBIDDEN;
  if (!isColumnView(view)) return BAD_VIEW;

  await db
    .delete(tableColumnConfig)
    .where(eq(tableColumnConfig.viewKey, view));

  revalidateView(view);
  return { ok: true, message: "Columns reset to the defaults." };
}
