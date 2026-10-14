/**
 * Server-side report rendering for email delivery (spec 26 phase 2, slice 2b):
 * a compact HTML-table payload (capped) plus a full CSV or Excel attachment, both
 * built from a `ReportResult`. Reuses the pure `reportToCsv` / `cellText` from the
 * client exporter (those are pure — the browser-only code in that module lives
 * inside functions we don't call here). Runs server-side (Node); exceljs is
 * lazy-imported only when an Excel attachment is requested.
 */

import { cellText, reportToCsv } from "./report-export";
import type { ReportResult } from "./report-spec";

const PREVIEW_ROWS = 50;

export interface EmailTable {
  columns: { label: string; align: "left" | "right" }[];
  rows: string[][];
  shown: number;
  total: number;
}

/** The capped, display-formatted table for the email body. */
export function reportEmailTable(
  result: ReportResult,
  cap: number = PREVIEW_ROWS,
): EmailTable {
  const columns = result.columns.map((c) => ({
    label: c.label,
    align: (c.type === "number" || c.type === "date" ? "right" : "left") as
      | "left"
      | "right",
  }));
  const rows = result.rows
    .slice(0, cap)
    .map((row) => row.map((cell, i) => cellText(cell, result.columns[i].type)));
  return { columns, rows, shown: rows.length, total: result.totalRows };
}

export interface ReportAttachment {
  filename: string;
  /** base64-encoded file bytes (what Resend's `attachments[].content` wants). */
  content: string;
  contentType: string;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "report"
  );
}

/** Build the full-data attachment for a scheduled report. CSV is pure; Excel is
   produced with exceljs (lazy-imported) in Node. */
export async function buildReportAttachment(
  result: ReportResult,
  name: string,
  format: "csv" | "xlsx",
): Promise<ReportAttachment> {
  const base = `opus-${slug(name)}-${new Date().toISOString().slice(0, 10)}`;

  if (format === "xlsx") {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "H2Tecs";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Report");
    sheet.columns = result.columns.map((c) => ({
      header: c.label,
      key: c.id,
      width: Math.min(44, Math.max(12, c.label.length + 2)),
    }));
    for (const row of result.rows) {
      const record: Record<string, number | string | null> = {};
      result.columns.forEach((c, i) => {
        const v = row[i];
        record[c.id] =
          v == null || v === ""
            ? null
            : typeof v === "number"
              ? v
              : cellText(v, c.type);
      });
      sheet.addRow(record);
    }
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    return {
      filename: `${base}.xlsx`,
      content: Buffer.from(buffer).toString("base64"),
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }

  // CSV (default): a UTF-8 BOM so Excel reads non-ASCII cells correctly.
  const csv = "﻿" + reportToCsv(result);
  return {
    filename: `${base}.csv`,
    content: Buffer.from(csv, "utf8").toString("base64"),
    contentType: "text/csv;charset=utf-8",
  };
}
