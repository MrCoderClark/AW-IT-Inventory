import "server-only";

import {
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { FieldType, Operator, ReportFilter } from "@/lib/report-spec";

/* Minimal, safe SQL push-down for the reporting engine (spec 26 phase 2 extra).
   Each source may pass a map of its *direct* columns (field id → column); this
   builds a conservative WHERE for the subset of filters it can translate with
   semantics that are EQUAL-OR-LOOSER than the in-memory `matchFilter`. Because
   `runReport` re-applies EVERY filter in memory, a pushed predicate can only
   reduce the rows loaded — it can never change the result. Anything uncertain is
   skipped (left to memory): computed fields (not in the map), dates, negations
   (null-handling differs), and non-ASCII text (Postgres ILIKE vs JS toLowerCase
   case-folding could diverge). LIMIT is never pushed (it applies after group/sort,
   which stay in memory). */

const ASCII = /^[\x00-\x7F]*$/;

/** Whether a (type, operator, value) filter is safe to translate to SQL. Pure —
   this is where the safety decision lives, and it's unit-tested. */
export function isPushable(
  type: FieldType,
  op: Operator,
  value: ReportFilter["value"],
  values?: string[],
): boolean {
  switch (op) {
    case "isEmpty":
    case "isNotEmpty":
      return true; // null/'' checks map cleanly for any column
    case "isTrue":
    case "isFalse":
      return type === "bool";
    case "in":
      return type === "enum" && Array.isArray(values) && values.length > 0;
    case "eq":
      // enum eq is case-insensitive in memory → ASCII-only (ILIKE case-fold parity).
      if (type === "enum" || type === "text")
        return typeof value === "string" && ASCII.test(value);
      if (type === "number") return Number.isFinite(Number(value));
      return false; // dates: skip (parse/timezone divergence)
    case "contains":
      return typeof value === "string" && ASCII.test(value);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return type === "number" && Number.isFinite(Number(value));
    case "between":
      return false; // handled explicitly below only for numbers
    default:
      // neq / notContains: NULL rows match in memory but not in SQL (stricter) → skip.
      // date before/after/on: parse divergence → skip.
      return false;
  }
}

/** Escape LIKE wildcards so a user value is matched literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function predicate(
  col: PgColumn,
  type: FieldType,
  f: ReportFilter,
): SQL | undefined {
  switch (f.op) {
    case "isEmpty":
      // Only text can be the empty string; for other types "empty" means NULL
      // (comparing a timestamp/int/bool column to '' would error).
      return type === "text" ? or(isNull(col), eq(col, "")) : isNull(col);
    case "isNotEmpty":
      return type === "text" ? and(isNotNull(col), ne(col, "")) : isNotNull(col);
    case "isTrue":
      return eq(col, true);
    case "isFalse":
      return eq(col, false);
  }

  if (type === "enum") {
    if (f.op === "in" && f.values?.length) return inArray(col, f.values);
    // Case-insensitive eq to match matchFilter; cast handles real pg enums too.
    if (f.op === "eq" && typeof f.value === "string" && ASCII.test(f.value))
      return sql`${col}::text ilike ${likeEscape(f.value)}`;
    return undefined;
  }

  if (type === "number") {
    const n = Number(f.value);
    if (!Number.isFinite(n)) return undefined;
    switch (f.op) {
      case "eq":
        return eq(col, n);
      case "gt":
        return gt(col, n);
      case "gte":
        return gte(col, n);
      case "lt":
        return lt(col, n);
      case "lte":
        return lte(col, n);
      case "between": {
        const n2 = Number(f.value2);
        if (!Number.isFinite(n2)) return undefined;
        return and(gte(col, Math.min(n, n2)), lte(col, Math.max(n, n2)));
      }
      default:
        return undefined;
    }
  }

  if (type === "text" && typeof f.value === "string" && ASCII.test(f.value)) {
    if (f.op === "contains") return ilike(col, `%${likeEscape(f.value)}%`);
    if (f.op === "eq") return ilike(col, likeEscape(f.value)); // case-insensitive, no wildcards
  }

  return undefined;
}

/**
 * Build the pushed-down WHERE for the filters whose field is a pushable direct
 * column. Returns undefined when nothing is pushable (the source then loads its
 * full base query, as before). `between` is translated only for numbers, via the
 * number branch above.
 */
export function buildPushdownWhere(
  filters: ReportFilter[],
  types: Record<string, FieldType>,
  columns: Record<string, PgColumn>,
): SQL | undefined {
  const preds: SQL[] = [];
  for (const f of filters) {
    const col = columns[f.field];
    const type = types[f.field];
    if (!col || !type) continue;
    const pushableNow =
      f.op === "between"
        ? type === "number" && Number.isFinite(Number(f.value))
        : isPushable(type, f.op, f.value, f.values);
    if (!pushableNow) continue;
    const p = predicate(col, type, f);
    if (p) preds.push(p);
  }
  return preds.length ? and(...preds) : undefined;
}
