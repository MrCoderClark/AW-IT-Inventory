/**
 * CSV export for the asset tables (backlog "Export (CSV)"). Pure and
 * dependency-free so the table component and its tests both import it. The
 * export mirrors what the user sees: the same resolved columns (spec 11), in the
 * same order, for the current filtered + sorted rows. The row set and column ids
 * are chosen by the caller (the table instance); this module only turns an
 * `Asset` + a `ColumnId` into a plain-text cell and assembles RFC 4180 CSV.
 */

import { STATUS_META, type Asset } from "@/lib/data";
import {
  COLUMN_LABELS,
  LOCKED_LAST,
  type ColumnId,
} from "@/lib/table-columns";

const REACHABILITY_LABEL: Record<string, string> = {
  up: "Up",
  down: "Down",
  unknown: "Unknown",
};

/** The plain-text value of one column for one asset — the export counterpart of
   the table's rendered cell. Unknown/absent values become an empty string. */
export function assetCsvValue(asset: Asset, id: ColumnId): string {
  switch (id) {
    case "id":
      return asset.id;
    case "name":
      return asset.name;
    case "type":
      return asset.type;
    case "serial":
      return asset.serial ?? "";
    case "model":
      return asset.model ?? "";
    case "assignee":
      return asset.assignee?.name ?? "";
    case "location":
      return asset.location ?? "";
    case "status":
      return STATUS_META[asset.status]?.label ?? asset.status;
    case "lastSync":
      // ISO datetime → the date portion, which is what a spreadsheet wants.
      return asset.lastSync ? asset.lastSync.slice(0, 10) : "";
    case "ip":
      return asset.ip ?? "";
    case "mac":
      return asset.mac ?? "";
    case "phoneNumber":
      return asset.phoneNumber ?? "";
    case "reachability":
      return asset.reachability
        ? (REACHABILITY_LABEL[asset.reachability.state] ??
            asset.reachability.state)
        : "";
    case "pages":
      return asset.pageCount == null ? "" : String(asset.pageCount);
    case "actions":
      return ""; // never exported (filtered out before this is called)
  }
}

/** Quote a field per RFC 4180: wrap in double quotes when it contains a comma,
   quote, or newline, doubling any interior quote. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Assemble CSV text from the given rows and column ids. The `actions` column is
 * always dropped (it has no exportable value); a header row of human labels
 * leads. Rows are joined with CRLF (RFC 4180). The caller passes the already
 * filtered + sorted assets so the file matches the on-screen view.
 */
export function assetsToCsv(assets: Asset[], ids: ColumnId[]): string {
  const cols = ids.filter((id) => id !== LOCKED_LAST);
  const header = cols.map((id) => csvField(COLUMN_LABELS[id]));
  const lines = [header.join(",")];
  for (const asset of assets) {
    lines.push(cols.map((id) => csvField(assetCsvValue(asset, id))).join(","));
  }
  return lines.join("\r\n");
}
