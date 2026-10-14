import "server-only";

import { getReport, runReportBySpec } from "./report-engine";
import { advanceSchedule, listDueSchedules } from "./report-schedules";
import { sendReportEmail } from "@/lib/notify";
import { buildReportAttachment, reportEmailTable } from "@/lib/report-attachment";

/* Scheduled report delivery (spec 26 phase 2, slice 2b). Finds the schedules that
   are due, runs each report live, emails it (web builds the preview + attachment,
   aw-auth sends), and rolls the schedule forward. Called by the worker's periodic
   trigger via POST /api/scan/reports/deliver. Server-only.

   Advance rules: a sent delivery advances `nextRunAt` so it fires once per period;
   a *transient* send failure is left pending (retries next sweep); a report that
   throws when run is advanced anyway, so one broken definition can't be retried on
   every tick. */

export interface DeliveryResult {
  due: number;
  delivered: number;
  failed: number;
}

export async function deliverDueReports(
  now: Date = new Date(),
): Promise<DeliveryResult> {
  const due = await listDueSchedules(now);
  let delivered = 0;
  let failed = 0;

  for (const sched of due) {
    const report = await getReport(sched.reportId);
    if (!report) {
      // The FK cascades, so this shouldn't happen; if it does the row is gone
      // and won't recur. Nothing to advance.
      failed += 1;
      continue;
    }

    let result;
    try {
      result = await runReportBySpec(report.spec);
    } catch (err) {
      console.error(
        `[report-delivery] run failed for "${report.name}" (${report.id}):`,
        err,
      );
      // Broken definition — advance so it doesn't retry every tick.
      await advanceSchedule(sched.id, now);
      failed += 1;
      continue;
    }

    try {
      const table = reportEmailTable(result);
      const attachment = await buildReportAttachment(
        result,
        report.name,
        sched.format,
      );
      const sent = await sendReportEmail({
        report: { name: report.name, description: report.description },
        table,
        recipients: sched.recipients,
        attachment,
      });
      if (sent) {
        await advanceSchedule(sched.id, now);
        delivered += 1;
      } else {
        // Transient (Resend/aw-auth) miss — leave pending to retry next sweep.
        failed += 1;
      }
    } catch (err) {
      console.error(
        `[report-delivery] delivery failed for "${report.name}" (${report.id}):`,
        err,
      );
      failed += 1;
    }
  }

  return { due: due.length, delivered, failed };
}
