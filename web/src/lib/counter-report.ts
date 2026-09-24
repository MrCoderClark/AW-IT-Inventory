import "server-only";

import { assembleCounterReport } from "@/db/counters";
import { sendCounterReportEmail } from "@/lib/notify";

/**
 * The one shared entry point for the daily printer page-counter report (spec 14).
 * Both send paths — the worker's scheduled `POST /api/scan/counter-report/send`
 * (AC-4) and the admin's manual `sendCounterReportNow` server action (AC-5) —
 * call this: it assembles the per-printer rows (total + delta, "no reading" for a
 * printer missed that day) from the counter history and posts them to aw-auth,
 * which resolves the admins and sends the email via Resend.
 *
 * Returns whether the email was actually delivered and how many printers were in
 * it, so either caller can report the outcome. Never throws for a delivery
 * failure — that is surfaced as `sent: false`.
 */
export async function sendCounterReport(): Promise<{
  sent: boolean;
  printers: number;
}> {
  const rows = await assembleCounterReport();
  const sent = await sendCounterReportEmail(rows);
  return { sent, printers: rows.length };
}
