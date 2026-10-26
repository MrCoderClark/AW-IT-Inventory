// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  getUserMock,
  hasPermMock,
  resolveTargetMock,
  enqueueMock,
  cancelMock,
  upsertScheduleMock,
  setEnabledMock,
  deleteScheduleMock,
  getScheduleMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  resolveTargetMock: vi.fn(),
  enqueueMock: vi.fn(),
  cancelMock: vi.fn(),
  upsertScheduleMock: vi.fn(),
  setEnabledMock: vi.fn(),
  deleteScheduleMock: vi.fn(),
  getScheduleMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("@/db/reboot", () => ({
  enqueueRebootJob: enqueueMock,
  cancelRebootJob: cancelMock,
}));
vi.mock("@/db/reboot-schedules", () => ({
  upsertRebootSchedule: upsertScheduleMock,
  setRebootScheduleEnabled: setEnabledMock,
  deleteRebootSchedule: deleteScheduleMock,
  getRebootScheduleForAssetTag: getScheduleMock,
}));
vi.mock("@/db/patch-install", () => ({
  resolveDeployTarget: resolveTargetMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  deleteRebootScheduleAction,
  requestCancelReboot,
  requestRebootSchedule,
  setRebootScheduleEnabledAction,
  upsertRebootScheduleAction,
} from "./reboot-actions";

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ email: "me@opus.local" });
  hasPermMock.mockReturnValue(true);
});

describe("requestRebootSchedule", () => {
  it("refuses without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect(
      await requestRebootSchedule({
        assetTag: "PC1",
        scheduledAtIso: "2026-12-01T12:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("enqueues when target and schedule are valid", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    enqueueMock.mockResolvedValue({ ok: true, id: "r1" });
    const res = await requestRebootSchedule({
      assetTag: "PC1",
      scheduledAtIso: "2026-12-01T12:00:00.000Z",
    });
    expect(res).toEqual({ ok: true, id: "r1" });
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "a1",
        targetIp: "10.0.0.1",
        requestedBy: "me@opus.local",
      }),
    );
  });

  it("refuses a schedule time in the past", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    enqueueMock.mockResolvedValue({ ok: false, reason: "past-schedule" });
    expect(
      await requestRebootSchedule({
        assetTag: "PC1",
        scheduledAtIso: "2020-01-01T12:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, code: "badrequest" });
  });

  it("refuses an invalid ISO schedule time", async () => {
    expect(
      await requestRebootSchedule({
        assetTag: "PC1",
        scheduledAtIso: "not-a-date",
      }),
    ).toMatchObject({ ok: false, code: "badrequest" });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("refuses when the computer has no deploy target IP", async () => {
    resolveTargetMock.mockResolvedValue(null);
    expect(
      await requestRebootSchedule({
        assetTag: "PC1",
        scheduledAtIso: "2026-12-01T12:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, code: "badrequest" });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("surfaces an in-flight reboot conflict", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    enqueueMock.mockResolvedValue({ ok: false, reason: "already-inflight" });
    expect(
      await requestRebootSchedule({
        assetTag: "PC1",
        scheduledAtIso: "2026-12-01T12:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("requestCancelReboot", () => {
  it("refuses without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect(
      await requestCancelReboot({ id: "r1", assetTag: "PC1" }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });
});

const dailySchedule = {
  assetTag: "PC1",
  cadence: "daily" as const,
  localTime: "03:00",
  timezone: "America/New_York",
};

describe("upsertRebootScheduleAction", () => {
  it("refuses without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect(await upsertRebootScheduleAction(dailySchedule)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(upsertScheduleMock).not.toHaveBeenCalled();
  });

  it("upserts when target and schedule fields are valid", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    upsertScheduleMock.mockResolvedValue({ ok: true, id: "sch1" });
    const saved = {
      id: "sch1",
      assetId: "a1",
      cadence: "daily" as const,
      weekdays: null,
      localTime: "03:00",
      timezone: "America/New_York",
      enabled: true,
      requestedBy: "me@opus.local",
      nextJobId: "job-1",
      nextRunAtIso: "2026-10-24T07:00:00.000Z",
    };
    getScheduleMock.mockResolvedValue(saved);
    const res = await upsertRebootScheduleAction(dailySchedule);
    expect(res).toEqual({ ok: true, id: "sch1", schedule: saved });
    expect(getScheduleMock).toHaveBeenCalledWith("PC1");
    expect(upsertScheduleMock).toHaveBeenCalledWith({
      assetId: "a1",
      targetIp: "10.0.0.1",
      cadence: "daily",
      weekdays: null,
      localTime: "03:00",
      timezone: "America/New_York",
      requestedBy: "me@opus.local",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/assets/PC1");
  });

  it("passes weekdays for weekly cadence", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    upsertScheduleMock.mockResolvedValue({ ok: true, id: "sch1" });
    await upsertRebootScheduleAction({
      ...dailySchedule,
      cadence: "weekly",
      weekdays: [1, 3],
    });
    expect(upsertScheduleMock).toHaveBeenCalledWith(
      expect.objectContaining({ cadence: "weekly", weekdays: [1, 3] }),
    );
  });

  it("refuses when the computer has no deploy target IP", async () => {
    resolveTargetMock.mockResolvedValue(null);
    expect(await upsertRebootScheduleAction(dailySchedule)).toMatchObject({
      ok: false,
      code: "badrequest",
    });
    expect(upsertScheduleMock).not.toHaveBeenCalled();
  });

  it("refuses invalid schedule input from the db layer", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    upsertScheduleMock.mockResolvedValue({ ok: false, reason: "bad-input" });
    expect(
      await upsertRebootScheduleAction({
        ...dailySchedule,
        localTime: "25:99",
      }),
    ).toMatchObject({ ok: false, code: "badrequest" });
  });
});

describe("setRebootScheduleEnabledAction", () => {
  it("refuses without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect(
      await setRebootScheduleEnabledAction({ assetTag: "PC1", enabled: false }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("toggles enabled and revalidates", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    setEnabledMock.mockResolvedValue(true);
    expect(
      await setRebootScheduleEnabledAction({ assetTag: "PC1", enabled: true }),
    ).toEqual({ ok: true });
    expect(setEnabledMock).toHaveBeenCalledWith("a1", true, "me@opus.local");
    expect(revalidatePathMock).toHaveBeenCalledWith("/assets/PC1");
  });

  it("returns notfound when no schedule exists", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    setEnabledMock.mockResolvedValue(false);
    expect(
      await setRebootScheduleEnabledAction({ assetTag: "PC1", enabled: false }),
    ).toMatchObject({ ok: false, code: "notfound" });
  });
});

describe("deleteRebootScheduleAction", () => {
  it("refuses without software:deploy", async () => {
    hasPermMock.mockReturnValue(false);
    expect(await deleteRebootScheduleAction({ assetTag: "PC1" })).toMatchObject(
      { ok: false, code: "forbidden" },
    );
  });

  it("deletes and revalidates", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    deleteScheduleMock.mockResolvedValue(true);
    expect(await deleteRebootScheduleAction({ assetTag: "PC1" })).toEqual({
      ok: true,
    });
    expect(deleteScheduleMock).toHaveBeenCalledWith("a1", "me@opus.local");
    expect(revalidatePathMock).toHaveBeenCalledWith("/assets/PC1");
  });

  it("returns notfound when no schedule exists", async () => {
    resolveTargetMock.mockResolvedValue({ assetId: "a1", ip: "10.0.0.1" });
    deleteScheduleMock.mockResolvedValue(false);
    expect(await deleteRebootScheduleAction({ assetTag: "PC1" })).toMatchObject(
      { ok: false, code: "notfound" },
    );
  });
});
