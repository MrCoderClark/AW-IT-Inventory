import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the alert-rule Server Actions (spec 30, AC-1). DB helpers, the
 * auth session, and Next's cache are mocked; the user:admin gate and the
 * schema run for real.
 */

const {
  createMock,
  updateMock,
  deleteMock,
  setEnabledMock,
  getCurrentUserMock,
  hasPermissionMock,
  revalidateMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  setEnabledMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("@/db/alert-rules", () => ({
  createAlertRule: createMock,
  updateAlertRule: updateMock,
  deleteAlertRule: deleteMock,
  setAlertRuleEnabled: setEnabledMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
  hasPermission: hasPermissionMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import {
  createAlertRuleAction,
  deleteAlertRuleAction,
  setAlertRuleEnabledAction,
  updateAlertRuleAction,
} from "./alert-rule-actions";

const VALID = {
  name: "CPU high",
  signal: "cpu_pct",
  op: "gte",
  threshold: 90,
  consecutive: 2,
  severity: "warning",
  ticketAutoCreate: "inherit" as const,
};

const RULE_ID = "a3000000-0000-4000-8000-000000000001";

function grant(allowed: boolean) {
  getCurrentUserMock.mockResolvedValue(allowed ? { email: "a@x.co" } : null);
  hasPermissionMock.mockReturnValue(allowed);
}

beforeEach(() => vi.clearAllMocks());

describe("alert-rule actions — permission gate (AC-1)", () => {
  it("refuses a caller without user:admin and writes nothing", async () => {
    grant(false);
    const res = await createAlertRuleAction(VALID);
    expect(res.ok).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe("createAlertRuleAction", () => {
  beforeEach(() => grant(true));

  it("rejects invalid input without writing", async () => {
    const res = await createAlertRuleAction({ ...VALID, name: "" });
    expect(res.ok).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates the rule, revalidates, and returns ok", async () => {
    createMock.mockResolvedValue({ id: "new-id", ...VALID, enabled: true });
    const res = await createAlertRuleAction(VALID);
    expect(createMock).toHaveBeenCalledWith(VALID);
    expect(revalidateMock).toHaveBeenCalledWith("/admin/alert-rules");
    expect(res.ok).toBe(true);
  });
});

describe("updateAlertRuleAction", () => {
  beforeEach(() => grant(true));

  it("reports a missing rule", async () => {
    updateMock.mockResolvedValue(null);
    const res = await updateAlertRuleAction(RULE_ID, VALID);
    expect(res.ok).toBe(false);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("updates, revalidates, and returns ok", async () => {
    updateMock.mockResolvedValue({ id: RULE_ID, ...VALID, enabled: true });
    const res = await updateAlertRuleAction(RULE_ID, VALID);
    expect(updateMock).toHaveBeenCalledWith(RULE_ID, VALID);
    expect(res.ok).toBe(true);
  });
});

describe("deleteAlertRuleAction / setAlertRuleEnabledAction", () => {
  beforeEach(() => grant(true));

  it("deletes a rule", async () => {
    deleteMock.mockResolvedValue(true);
    const res = await deleteAlertRuleAction(RULE_ID);
    expect(deleteMock).toHaveBeenCalledWith(RULE_ID);
    expect(res.ok).toBe(true);
  });

  it("enables a rule", async () => {
    setEnabledMock.mockResolvedValue({
      id: RULE_ID,
      ...VALID,
      enabled: true,
    });
    const res = await setAlertRuleEnabledAction(RULE_ID, true);
    expect(setEnabledMock).toHaveBeenCalledWith(RULE_ID, true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toMatch(/Enabled/i);
  });

  it("rejects a non-boolean enabled flag", async () => {
    const res = await setAlertRuleEnabledAction(RULE_ID, "yes");
    expect(res.ok).toBe(false);
    expect(setEnabledMock).not.toHaveBeenCalled();
  });
});
