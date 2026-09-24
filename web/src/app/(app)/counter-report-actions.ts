"use server";

import { sendCounterReport } from "@/lib/counter-report";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to send the counter report.",
};

/**
 * Send the printer page-counter report on demand (spec 14, AC-5). Gated on
 * `scan:write`, rechecked server-side (AC-7): the Admin page hides the button
 * without it, and this refuses the call even if invoked directly. Runs the same
 * shared `sendCounterReport()` as the worker's daily job.
 */
export async function sendCounterReportNow(): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!hasPermission(user, "scan:write")) return FORBIDDEN;

  const { sent, printers } = await sendCounterReport();
  if (!sent) {
    return {
      ok: false,
      error:
        "The report could not be delivered. Check the aw-auth Resend settings and try again.",
    };
  }
  return {
    ok: true,
    message: `Counter report sent for ${printers} printer${printers === 1 ? "" : "s"}.`,
  };
}
