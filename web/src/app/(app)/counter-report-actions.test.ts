import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the sendCounterReportNow server action (spec 14). The auth session
 * and the shared report sender are mocked. Locks AC-5 / AC-7 (a caller without
 * scan:write is refused server-side, even if the button is hidden) and the
 * not-delivered path (a failed send returns an error, not a false success).
 */

const { getUserMock, hasPermMock, sendMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("@/lib/counter-report", () => ({ sendCounterReport: sendMock }));

import { sendCounterReportNow } from "./counter-report-actions";

beforeEach(() => vi.clearAllMocks());

describe("sendCounterReportNow — permission gate (AC-5, AC-7)", () => {
  it("refuses a caller without scan:write and never sends", async () => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(false);

    const res = await sendCounterReportNow();

    expect(res.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
    expect(hasPermMock).toHaveBeenCalledWith({ id: "u1" }, "scan:write");
  });
});

describe("sendCounterReportNow — send result", () => {
  beforeEach(() => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(true);
  });

  it("sends and reports how many printers were covered (plural)", async () => {
    sendMock.mockResolvedValue({ sent: true, printers: 2 });
    const res = await sendCounterReportNow();
    expect(res).toEqual({ ok: true, message: "Counter report sent for 2 printers." });
  });

  it("uses the singular for a single printer", async () => {
    sendMock.mockResolvedValue({ sent: true, printers: 1 });
    const res = await sendCounterReportNow();
    expect(res).toMatchObject({ ok: true, message: "Counter report sent for 1 printer." });
  });

  it("returns an error when the report could not be delivered (sent === false)", async () => {
    sendMock.mockResolvedValue({ sent: false, printers: 3 });
    const res = await sendCounterReportNow();
    expect(res.ok).toBe(false);
  });
});
