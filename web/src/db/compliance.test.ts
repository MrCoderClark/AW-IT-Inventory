import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for compliance alerting (spec 21 v2): the transition logic in
 * `evaluateComplianceAlert`. The DB client and `createNotification` are mocked; the
 * scoring is the real pure function. We lock the state machine: alert once on the
 * clean→at-risk crossing, nothing while it stays at-risk, a recovery notice on the
 * way back, silence on a first-ever clean read, and "advance state only after a
 * successful send".
 */
const H = vi.hoisted(() => {
  const state: { row: Record<string, unknown> | null; updates: unknown[] } = {
    row: null,
    updates: [],
  };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "innerJoin", "where", "limit"]) b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.row ? [state.row] : []).then(res, rej);
    return b;
  };
  const selectMock = vi.fn(() => makeSelect());
  const updateMock = vi.fn(() => ({
    set: (v: unknown) => {
      state.updates.push(v);
      return { where: () => Promise.resolve() };
    },
  }));
  const notifyMock = vi.fn(
    async (_input: Record<string, unknown>) => "notif-id" as string | null,
  );

  return { state, selectMock, updateMock, notifyMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: { select: H.selectMock, update: H.updateMock },
}));
vi.mock("./notifications", () => ({ createNotification: H.notifyMock }));

import { evaluateComplianceAlert } from "./compliance";

/** A fully-clean posture row (joined shape: posture + tag/name + alertedState). */
function cleanRow(alertedState: "ok" | "at-risk" | null) {
  return {
    tag: "OPUS-COMP-1",
    name: "Reception PC",
    bitlocker: "on",
    defenderRealtime: true,
    defenderSigAgeDays: 2,
    avProduct: "Windows Defender",
    tpmReady: true,
    secureBoot: "on",
    updatesLastDays: 5,
    updatesPending: 0,
    systemDrivePctUsed: 40,
    alertedState,
  };
}
const AT_RISK = { bitlocker: "off", defenderRealtime: false };

beforeEach(() => {
  vi.clearAllMocks();
  H.state.row = null;
  H.state.updates = [];
  H.notifyMock.mockResolvedValue("notif-id");
});

describe("evaluateComplianceAlert", () => {
  const NOW = new Date("2026-10-13T12:00:00Z");

  it("fires an at-risk alert on the clean→at-risk crossing and advances state", async () => {
    H.state.row = { ...cleanRow("ok"), ...AT_RISK };
    await evaluateComplianceAlert("a1", NOW);
    expect(H.notifyMock).toHaveBeenCalledTimes(1);
    expect(H.notifyMock.mock.calls[0][0]).toMatchObject({
      type: "compliance-at-risk",
      assetId: "a1",
      href: "/assets/OPUS-COMP-1",
    });
    expect(H.state.updates).toEqual([{ alertedState: "at-risk" }]);
  });

  it("stays quiet while it remains at-risk", async () => {
    H.state.row = { ...cleanRow("at-risk"), ...AT_RISK };
    await evaluateComplianceAlert("a1", NOW);
    expect(H.notifyMock).not.toHaveBeenCalled();
    expect(H.state.updates).toHaveLength(0);
  });

  it("fires a recovery notice on at-risk→clean and clears state", async () => {
    H.state.row = cleanRow("at-risk");
    await evaluateComplianceAlert("a1", NOW);
    expect(H.notifyMock).toHaveBeenCalledTimes(1);
    expect(H.notifyMock.mock.calls[0][0]).toMatchObject({
      type: "compliance-recovered",
    });
    expect(H.state.updates).toEqual([{ alertedState: "ok" }]);
  });

  it("a first-ever clean read records ok silently (no notification)", async () => {
    H.state.row = cleanRow(null);
    await evaluateComplianceAlert("a1", NOW);
    expect(H.notifyMock).not.toHaveBeenCalled();
    expect(H.state.updates).toEqual([{ alertedState: "ok" }]);
  });

  it("does not advance state when the send fails (retries next scan)", async () => {
    H.notifyMock.mockResolvedValue(null); // send failed / errored
    H.state.row = { ...cleanRow("ok"), ...AT_RISK };
    await evaluateComplianceAlert("a1", NOW);
    expect(H.notifyMock).toHaveBeenCalledTimes(1);
    expect(H.state.updates).toHaveLength(0); // state unchanged
  });

  it("never alerts on an unassessed device (all posture unknown)", async () => {
    H.state.row = {
      tag: "OPUS-COMP-2",
      name: "Blank PC",
      bitlocker: null,
      defenderRealtime: null,
      defenderSigAgeDays: null,
      avProduct: null,
      tpmReady: null,
      secureBoot: null,
      updatesLastDays: null,
      updatesPending: null,
      systemDrivePctUsed: null,
      alertedState: null,
    };
    await evaluateComplianceAlert("a2", NOW);
    expect(H.notifyMock).not.toHaveBeenCalled();
    expect(H.state.updates).toHaveLength(0);
  });
});
