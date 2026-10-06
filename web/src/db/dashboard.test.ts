import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the dashboard widget-toggle helpers. The DB client is the
 * boundary (mocked); the coalescing rule (absent row = on) and the upsert write
 * run for real.
 */

const { selectMock, fromMock, insertMock, valuesMock, onConflictMock } =
  vi.hoisted(() => {
    const fromMock = vi.fn();
    const selectMock = vi.fn(() => ({ from: fromMock }));
    const onConflictMock = vi.fn((_config?: unknown) => Promise.resolve());
    const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictMock }));
    const insertMock = vi.fn(() => ({ values: valuesMock }));
    return { selectMock, fromMock, insertMock, valuesMock, onConflictMock };
  });

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: { select: selectMock, insert: insertMock },
}));

import {
  DASHBOARD_WIDGETS,
  getDashboardWidgetSettings,
  isDashboardWidgetId,
  setDashboardWidget,
} from "./dashboard";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDashboardWidgetSettings — absent row = on", () => {
  it("defaults every widget to on when the table is empty", async () => {
    fromMock.mockResolvedValue([]);
    expect(await getDashboardWidgetSettings()).toEqual({ "locations-map": true });
  });

  it("reflects a saved off value", async () => {
    fromMock.mockResolvedValue([{ widgetId: "locations-map", enabled: false }]);
    expect(await getDashboardWidgetSettings()).toEqual({
      "locations-map": false,
    });
  });
});

describe("setDashboardWidget — upsert", () => {
  it("upserts the row with the new enabled value", async () => {
    await setDashboardWidget("locations-map", false);
    expect(insertMock).toHaveBeenCalledOnce();
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ widgetId: "locations-map", enabled: false }),
    );
    const arg = onConflictMock.mock.calls[0][0] as { set: { enabled: boolean } };
    expect(arg.set).toEqual(expect.objectContaining({ enabled: false }));
  });
});

describe("isDashboardWidgetId", () => {
  it("accepts known widgets and rejects anything else", () => {
    for (const w of DASHBOARD_WIDGETS) expect(isDashboardWidgetId(w)).toBe(true);
    expect(isDashboardWidgetId("nope")).toBe(false);
    expect(isDashboardWidgetId(null)).toBe(false);
  });
});
