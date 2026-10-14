import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the scheduled-delivery orchestrator (spec 26 phase 2, slice 2b). The
 * engine, schedule store, email send and attachment builder are the boundaries
 * and are mocked. Locks the advance rules: a sent delivery advances the schedule;
 * a transient send failure leaves it pending (no advance) to retry; a report that
 * throws when run is advanced anyway so a broken definition can't retry forever.
 */

const {
  listDueMock,
  advanceMock,
  getReportMock,
  runMock,
  sendMock,
  tableMock,
  attachMock,
} = vi.hoisted(() => ({
  listDueMock: vi.fn(),
  advanceMock: vi.fn(),
  getReportMock: vi.fn(),
  runMock: vi.fn(),
  sendMock: vi.fn(),
  tableMock: vi.fn(),
  attachMock: vi.fn(),
}));

vi.mock("./report-schedules", () => ({
  listDueSchedules: listDueMock,
  advanceSchedule: advanceMock,
}));
vi.mock("./report-engine", () => ({
  getReport: getReportMock,
  runReportBySpec: runMock,
}));
vi.mock("@/lib/notify", () => ({ sendReportEmail: sendMock }));
vi.mock("@/lib/report-attachment", () => ({
  reportEmailTable: tableMock,
  buildReportAttachment: attachMock,
}));

import { deliverDueReports } from "./report-delivery";

const schedule = {
  id: "sch1",
  reportId: "r1",
  recipients: ["ops@co.com"],
  format: "csv" as const,
};
const report = { id: "r1", name: "R", description: null, spec: { source: "assets" } };

beforeEach(() => {
  vi.clearAllMocks();
  getReportMock.mockResolvedValue(report);
  runMock.mockResolvedValue({ columns: [], rows: [], totalRows: 0 });
  tableMock.mockReturnValue({ columns: [], rows: [], shown: 0, total: 0 });
  attachMock.mockResolvedValue({ filename: "r.csv", content: "", contentType: "text/csv" });
});

describe("deliverDueReports", () => {
  it("advances a schedule after a successful send", async () => {
    listDueMock.mockResolvedValue([schedule]);
    sendMock.mockResolvedValue(true);

    const res = await deliverDueReports();

    expect(res).toEqual({ due: 1, delivered: 1, failed: 0 });
    expect(advanceMock).toHaveBeenCalledWith("sch1", expect.any(Date));
  });

  it("leaves a schedule pending (no advance) on a transient send failure", async () => {
    listDueMock.mockResolvedValue([schedule]);
    sendMock.mockResolvedValue(false);

    const res = await deliverDueReports();

    expect(res).toEqual({ due: 1, delivered: 0, failed: 1 });
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it("advances (so it won't retry forever) when running the report throws", async () => {
    listDueMock.mockResolvedValue([schedule]);
    runMock.mockRejectedValue(new Error("bad source"));

    const res = await deliverDueReports();

    expect(res).toEqual({ due: 1, delivered: 0, failed: 1 });
    expect(advanceMock).toHaveBeenCalledWith("sch1", expect.any(Date));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does nothing when no schedules are due", async () => {
    listDueMock.mockResolvedValue([]);

    const res = await deliverDueReports();

    expect(res).toEqual({ due: 0, delivered: 0, failed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
