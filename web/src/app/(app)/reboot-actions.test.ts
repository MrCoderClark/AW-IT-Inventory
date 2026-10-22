// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  getUserMock,
  hasPermMock,
  resolveTargetMock,
  enqueueMock,
  cancelMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  hasPermMock: vi.fn(),
  resolveTargetMock: vi.fn(),
  enqueueMock: vi.fn(),
  cancelMock: vi.fn(),
}));

vi.mock("@/db/reboot", () => ({
  enqueueRebootJob: enqueueMock,
  cancelRebootJob: cancelMock,
}));
vi.mock("@/db/patch-install", () => ({
  resolveDeployTarget: resolveTargetMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getUserMock,
  hasPermission: hasPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requestCancelReboot, requestRebootSchedule } from "./reboot-actions";

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
