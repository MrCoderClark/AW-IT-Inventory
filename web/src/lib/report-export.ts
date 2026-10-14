/**
 * Client-side exporters for a report result (spec 26, slice 1c). The heavy
 * office libraries (exceljs, jspdf + autotable) are **dynamically imported**
 * inside the async exporters, so they ship as separate chunks loaded only when
 * someone actually exports — never on first paint. CSV is pure and
 * dependency-free. Everything here runs in the browser (Blob / anchor download),
 * so only client components import it.
 */

import type { CellValue, FieldType, ReportResult } from "./report-spec";

/** An ISO timestamp → its date portion; any other string passes through. */
function dateOnly(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  return m ? m[1] : s;
}

/** A cell as display text (CSV + PDF): booleans as Yes/No, dates trimmed to the
   day, empties as "". Numbers keep full precision (no thousands separators, so a
   spreadsheet re-imports them cleanly). */
export function cellText(v: CellValue, type: FieldType): string {
  if (v == null || v === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return String(v);
  if (type === "date") return dateOnly(v);
  return v;
}

/** A cell as a typed Excel value: real numbers stay numeric (so sums/sorts work
   in the sheet); everything else is the display text, or null for an empty cell. */
function cellExcel(v: CellValue, type: FieldType): number | string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  return cellText(v, type);
}

/** Quote a field per RFC 4180 when it contains a comma, quote or newline. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Assemble RFC 4180 CSV (CRLF rows, label header) from a report result. Pure. */
export function reportToCsv(result: ReportResult): string {
  const header = result.columns.map((c) => csvField(c.label)).join(",");
  const lines = [header];
  for (const row of result.rows) {
    lines.push(
      result.columns
        .map((c, i) => csvField(cellText(row[i], c.type)))
        .join(","),
    );
  }
  return lines.join("\r\n");
}

/** `opus-<slug>-<yyyy-mm-dd>.<ext>` from a report name. */
export function reportFilename(name: string, ext: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "report";
  return `opus-${slug}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

/** Trigger a browser download of the given bytes. */
function download(parts: BlobPart[], type: string, filename: string): void {
  const blob = new Blob(parts, { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export type ExportFormat = "csv" | "xlsx" | "pdf";

/** CSV download. A leading BOM makes Excel read non-ASCII cells correctly. */
export function exportCsv(result: ReportResult, name: string): void {
  download(
    ["﻿", reportToCsv(result)],
    "text/csv;charset=utf-8;",
    reportFilename(name, "csv"),
  );
}

/** Excel (.xlsx) download. Lazily imports exceljs. */
export async function exportExcel(
  result: ReportResult,
  name: string,
): Promise<void> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "OPUS";
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
      record[c.id] = cellExcel(row[i], c.type);
    });
    sheet.addRow(record);
  }
  const header = sheet.getRow(1);
  header.font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  download(
    [buffer],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    reportFilename(name, "xlsx"),
  );
}

/** PDF download. Lazily imports jspdf + jspdf-autotable. Wide reports go
   landscape so more columns fit. */
export async function exportPdf(
  result: ReportResult,
  name: string,
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;

  const doc = new jsPDF({
    orientation: result.columns.length > 6 ? "landscape" : "portrait",
    unit: "pt",
  });
  doc.setFontSize(14);
  doc.text(name || "Report", 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `${result.totalRows.toLocaleString()} row${result.totalRows === 1 ? "" : "s"} · ${new Date().toLocaleDateString()}`,
    40,
    56,
  );

  autoTable(doc, {
    startY: 70,
    head: [result.columns.map((c) => c.label)],
    body: result.rows.map((row) =>
      result.columns.map((c, i) => cellText(row[i], c.type)),
    ),
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [37, 99, 235], textColor: 255 },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    margin: { top: 70, left: 40, right: 40 },
  });

  doc.save(reportFilename(name, "pdf"));
}

/** Run the right exporter for a format. */
export async function exportReport(
  format: ExportFormat,
  result: ReportResult,
  name: string,
): Promise<void> {
  if (format === "csv") return exportCsv(result, name);
  if (format === "xlsx") return exportExcel(result, name);
  return exportPdf(result, name);
}
