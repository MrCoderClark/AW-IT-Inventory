import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assets } from "./schema";
import { buildPushdownWhere, isPushable } from "./report-pushdown";
import type { FieldType, Operator, ReportFilter } from "@/lib/report-spec";

/**
 * Tests for the minimal SQL push-down (spec 26 phase 2 extra). The key property is
 * SAFETY: `isPushable` only green-lights predicates whose SQL is equal-or-looser
 * than the in-memory `matchFilter`, and `buildPushdownWhere` only ever touches
 * fields in the source's direct-column map. (`runReport` re-filters everything, so
 * a pushed predicate can only trim rows — never change the result.)
 */

const P = (type: FieldType, op: Operator, value?: ReportFilter["value"], values?: string[]) =>
  isPushable(type, op, value, values);

describe("isPushable — safe set only", () => {
  it("pushes empty / not-empty for any type", () => {
    for (const t of ["text", "number", "date", "enum", "bool"] as FieldType[]) {
      expect(P(t, "isEmpty")).toBe(true);
      expect(P(t, "isNotEmpty")).toBe(true);
    }
  });

  it("pushes booleans only for bool fields", () => {
    expect(P("bool", "isTrue")).toBe(true);
    expect(P("bool", "isFalse")).toBe(true);
    expect(P("text", "isTrue")).toBe(false);
  });

  it("pushes enum 'in' (exact) and enum/text 'eq' only for ASCII values", () => {
    expect(P("enum", "in", undefined, ["a", "b"])).toBe(true);
    expect(P("enum", "in", undefined, [])).toBe(false);
    expect(P("enum", "eq", "Computer")).toBe(true);
    expect(P("text", "eq", "Dell")).toBe(true);
    expect(P("text", "eq", "café")).toBe(false); // non-ASCII → case-fold risk
    expect(P("text", "contains", "lat")).toBe(true);
    expect(P("text", "contains", "naïve")).toBe(false);
  });

  it("pushes numeric comparisons only with a finite number", () => {
    for (const op of ["eq", "gt", "gte", "lt", "lte"] as Operator[]) {
      expect(P("number", op, 16)).toBe(true);
      expect(P("number", op, "nope")).toBe(false);
    }
  });

  it("never pushes negations, date comparisons, or raw 'between'", () => {
    expect(P("text", "neq", "x")).toBe(false);
    expect(P("text", "notContains", "x")).toBe(false);
    expect(P("date", "before", "2026-01-01")).toBe(false);
    expect(P("date", "eq", "2026-01-01")).toBe(false);
    expect(P("number", "between", 1)).toBe(false); // handled only inside buildPushdownWhere
  });
});

describe("buildPushdownWhere — mapped columns only", () => {
  const types = { type: "enum" as FieldType, location: "text" as FieldType };
  const columns = { type: assets.type }; // `location` deliberately NOT mapped

  it("builds a condition for a mapped, pushable filter", () => {
    const where = buildPushdownWhere(
      [{ field: "type", op: "in", values: ["Computer"] }],
      types,
      columns,
    );
    expect(where).toBeDefined();
  });

  it("skips filters whose field is not in the column map", () => {
    const where = buildPushdownWhere(
      [{ field: "location", op: "contains", value: "Bronx" }],
      types,
      columns,
    );
    expect(where).toBeUndefined();
  });

  it("skips unsafe operators even on a mapped column", () => {
    const where = buildPushdownWhere(
      [{ field: "type", op: "neq", value: "Computer" }],
      types,
      columns,
    );
    expect(where).toBeUndefined();
  });
});
