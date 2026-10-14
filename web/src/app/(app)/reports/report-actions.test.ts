import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the report builder server actions (spec 26, slice 1b). The auth
 * session and the engine (run/CRUD) are mocked, but `validateSpec` is the real
 * one — these lock the two gates that matter: running needs `report:read`,
 * saving/deleting needs `report:write`, and a spec is validated against the
 * field catalog before it ever reaches the engine (no user SQL, unknown fields
 * dropped). `validateSpec` itself is exercised through these.
 */

const {
  getUserMock,
  hasPermMock,
  runMock,
  createMock,
  updateMock,
  getMock,
  deleteMock,
  upsertSchedMock,
  deleteSchedMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  runMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  getMock: vi.fn(),
  deleteMock: vi.fn(),
  upsertSchedMock: vi.fn(),
  deleteSchedMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The real report-engine imports the DB client + queries at module load; stub
// those so `importActual` can hand back the genuine (pure) `validateSpec`.
vi.mock("@/db/index", () => ({ db: {} }));
vi.mock("@/db/queries", () => ({
  getLocationPathMap: vi.fn(),
  getPrinterCounterMap: vi.fn(),
}));
vi.mock("@/db/report-engine", async () => {
  // Keep the real validateSpec; mock only the DB-touching entry points.
  const actual = await vi.importActual<typeof import("@/db/report-engine")>(
    "@/db/report-engine",
  );
  return {
    validateSpec: actual.validateSpec,
    runReportBySpec: runMock,
    createReport: createMock,
    updateReport: updateMock,
    getReport: getMock,
    deleteReport: deleteMock,
  };
});
vi.mock("@/db/report-schedules", () => ({
  upsertSchedule: upsertSchedMock,
  deleteSchedule: deleteSchedMock,
}));

import {
  deleteReportAction,
  deleteScheduleAction,
  runReportAction,
  saveReportAction,
  saveScheduleAction,
} from "./report-actions";

beforeEach(() => vi.clearAllMocks());

const assetsSpec = {
  source: "assets",
  columns: ["tag", "name"],
  filters: [],
};

describe("runReportAction — report:read gate", () => {
  it("refuses a caller without report:read and never runs", async () => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(false);

    const res = await runReportAction("assets", assetsSpec);

    expect(res.ok).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
    expect(hasPermMock).toHaveBeenCalledWith({ id: "u1" }, "report:read");
  });

  it("runs the cleaned spec for a report:read caller", async () => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(true);
    runMock.mockResolvedValue({ columns: [], rows: [], totalRows: 0 });

    const res = await runReportAction("assets", assetsSpec);

    expect(res.ok).toBe(true);
    expect(runMock).toHaveBeenCalledOnce();
  });

  it("rejects an empty spec (no columns, no grouping) before running", async () => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(true);

    const res = await runReportAction("assets", { source: "assets", columns: [], filters: [] });

    expect(res.ok).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe("saveReportAction — report:write gate", () => {
  it("refuses a caller without report:write and never writes", async () => {
    getUserMock.mockResolvedValue({ id: "u1", email: "a@b.c" });
    hasPermMock.mockReturnValue(false);

    const res = await saveReportAction({ name: "R", source: "assets", spec: assetsSpec });

    expect(res.ok).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("requires a name", async () => {
    getUserMock.mockResolvedValue({ id: "u1", email: "a@b.c" });
    hasPermMock.mockReturnValue(true);

    const res = await saveReportAction({ name: "  ", source: "assets", spec: assetsSpec });

    expect(res.ok).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates with the author email and the cleaned spec", async () => {
    getUserMock.mockResolvedValue({ id: "u1", email: "a@b.c" });
    hasPermMock.mockReturnValue(true);
    createMock.mockResolvedValue({ id: "r1" });

    const res = await saveReportAction({
      name: "  Dell laptops  ",
      source: "assets",
      // includes an unknown field that validateSpec must drop
      spec: { source: "assets", columns: ["tag", "bogus"], filters: [] },
    });

    expect(res).toMatchObject({ ok: true, id: "r1" });
    const arg = createMock.mock.calls[0][0];
    expect(arg.name).toBe("Dell laptops");
    expect(arg.createdBy).toBe("a@b.c");
    expect(arg.spec.columns).toEqual(["tag"]); // "bogus" dropped
  });

  it("updates an existing report when id is given", async () => {
    getUserMock.mockResolvedValue({ id: "u1", email: "a@b.c" });
    hasPermMock.mockReturnValue(true);
    getMock.mockResolvedValue({ id: "r1" });
    updateMock.mockResolvedValue({ id: "r1" });

    const res = await saveReportAction({ id: "r1", name: "R", source: "assets", spec: assetsSpec });

    expect(res).toMatchObject({ ok: true, id: "r1" });
    expect(updateMock).toHaveBeenCalledOnce();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("saveScheduleAction — report:write gate + validation", () => {
  const schedule = {
    cadence: "daily",
    hour: 9,
    minute: 0,
    recipients: ["ops@co.com"],
    format: "csv",
  };

  it("refuses a caller without report:write and never writes", async () => {
    getUserMock.mockResolvedValue({ id: "u1", email: "a@b.c" });
    hasPermMock.mockReturnValue(false);

    const res = await saveScheduleAction({ reportId: "r1", schedule });

    expect(res.ok).toBe(false);
    expect(upsertSchedMock).not.toHaveBeenCalled();
  });

  it("refuses when the report doesn't exist", async () => {
    getUserMock.mockResolvedValue({ id: "u1", email: "a@b.c" });
    hasPermMock.mockReturnValue(true);
    getMock.mockResolvedValue(null);

    const res = await saveScheduleAction({ reportId: "gone", schedule });

    expect(res.ok).toBe(false);
    expect(upsertSchedMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid schedule (no recipients) before writing", async () => {
    getUserMock.mockResolvedValue({ id: "u1", email: "a@b.c" });
    hasPermMock.mockReturnValue(true);
    getMock.mockResolvedValue({ id: "r1" });

    const res = await saveScheduleAction({
      reportId: "r1",
      schedule: { ...schedule, recipients: [] },
    });

    expect(res.ok).toBe(false);
    expect(upsertSchedMock).not.toHaveBeenCalled();
  });

  it("upserts a valid schedule for a writer", async () => {
    getUserMock.mockResolvedValue({ id: "u1", email: "a@b.c" });
    hasPermMock.mockReturnValue(true);
    getMock.mockResolvedValue({ id: "r1" });
    upsertSchedMock.mockResolvedValue({ enabled: true });

    const res = await saveScheduleAction({ reportId: "r1", enabled: true, schedule });

    expect(res.ok).toBe(true);
    expect(upsertSchedMock).toHaveBeenCalledOnce();
    const [reportIdArg, inputArg] = upsertSchedMock.mock.calls[0];
    expect(reportIdArg).toBe("r1");
    expect(inputArg.recipients).toEqual(["ops@co.com"]);
  });
});

describe("deleteScheduleAction — report:write gate", () => {
  it("refuses without report:write", async () => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(false);

    const res = await deleteScheduleAction("r1");

    expect(res.ok).toBe(false);
    expect(deleteSchedMock).not.toHaveBeenCalled();
  });

  it("removes the schedule for a writer", async () => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(true);
    deleteSchedMock.mockResolvedValue(true);

    const res = await deleteScheduleAction("r1");

    expect(res.ok).toBe(true);
    expect(deleteSchedMock).toHaveBeenCalledWith("r1");
  });
});

describe("deleteReportAction — report:write gate", () => {
  it("refuses without report:write", async () => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(false);

    const res = await deleteReportAction("r1");

    expect(res.ok).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes for a report:write caller", async () => {
    getUserMock.mockResolvedValue({ id: "u1" });
    hasPermMock.mockReturnValue(true);
    deleteMock.mockResolvedValue(true);

    const res = await deleteReportAction("r1");

    expect(res.ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith("r1");
  });
});
