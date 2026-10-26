import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Spec 32 on-alert helper. DB + script-runs are mocked. Locks: no-op without
 * scriptId; enqueue with scheduled actor; skip missing script / no IP /
 * already-inflight without throwing.
 */

const H = vi.hoisted(() => {
  const selectMock = vi.fn();
  const resolveMock = vi.fn();
  const enqueueMock = vi.fn();
  return { selectMock, resolveMock, enqueueMock };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
  },
}));
vi.mock("./script-runs", () => ({
  resolveDeployTarget: (...args: unknown[]) => H.resolveMock(...args),
  enqueueScriptRun: (...args: unknown[]) => H.enqueueMock(...args),
}));

import {
  getActiveRemediationScript,
  maybeEnqueueAlertRemediation,
} from "./alert-rule-remediation";

const SCRIPT_ID = "s3000000-0000-4000-8000-000000000001";
const SCRIPT = {
  id: SCRIPT_ID,
  name: "Clear temp",
  body: "Remove-Item C:\\Temp\\* -Recurse -Force",
  timeoutSeconds: 120,
  archivedAt: null,
};

function thenable(rows: unknown[]) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ["from", "where", "limit", "orderBy"]) b[m] = self;
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(res, rej);
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  H.selectMock.mockImplementation(() => thenable([SCRIPT]));
  H.resolveMock.mockResolvedValue({ assetId: "a1", ip: "192.168.72.10" });
  H.enqueueMock.mockResolvedValue({ ok: true, id: "job-1" });
});

describe("getActiveRemediationScript", () => {
  it("returns null for a non-uuid", async () => {
    expect(await getActiveRemediationScript("nope")).toBeNull();
    expect(H.selectMock).not.toHaveBeenCalled();
  });

  it("returns the active script row", async () => {
    const row = await getActiveRemediationScript(SCRIPT_ID);
    expect(row).toEqual({
      id: SCRIPT_ID,
      name: "Clear temp",
      body: SCRIPT.body,
      timeoutSeconds: 120,
    });
  });

  it("returns null when no row matches", async () => {
    H.selectMock.mockImplementation(() => thenable([]));
    expect(await getActiveRemediationScript(SCRIPT_ID)).toBeNull();
  });
});

describe("maybeEnqueueAlertRemediation", () => {
  it("no-ops when remediationScriptId is null", async () => {
    await maybeEnqueueAlertRemediation({
      ruleId: "rule-1",
      remediationScriptId: null,
      assetTag: "PC-1",
    });
    expect(H.selectMock).not.toHaveBeenCalled();
    expect(H.enqueueMock).not.toHaveBeenCalled();
  });

  it("enqueues with alert-rule actor and scheduled source", async () => {
    await maybeEnqueueAlertRemediation({
      ruleId: "rule-disk",
      remediationScriptId: SCRIPT_ID,
      assetTag: "PC-1",
    });
    expect(H.resolveMock).toHaveBeenCalledWith("PC-1");
    expect(H.enqueueMock).toHaveBeenCalledWith({
      assetId: "a1",
      targetIp: "192.168.72.10",
      scriptId: SCRIPT_ID,
      scriptSnapshot: {
        name: "Clear temp",
        body: SCRIPT.body,
        timeoutSeconds: 120,
      },
      requestedBy: "alert-rule:rule-disk",
      scheduled: true,
    });
  });

  it("skips when the script is missing without throwing", async () => {
    H.selectMock.mockImplementation(() => thenable([]));
    await expect(
      maybeEnqueueAlertRemediation({
        ruleId: "rule-1",
        remediationScriptId: SCRIPT_ID,
        assetTag: "PC-1",
      }),
    ).resolves.toBeUndefined();
    expect(H.enqueueMock).not.toHaveBeenCalled();
  });

  it("skips when the host has no IP without throwing", async () => {
    H.resolveMock.mockResolvedValue(null);
    await expect(
      maybeEnqueueAlertRemediation({
        ruleId: "rule-1",
        remediationScriptId: SCRIPT_ID,
        assetTag: "PC-1",
      }),
    ).resolves.toBeUndefined();
    expect(H.enqueueMock).not.toHaveBeenCalled();
  });

  it("skips already-inflight without throwing", async () => {
    H.enqueueMock.mockResolvedValue({ ok: false, reason: "already-inflight" });
    await expect(
      maybeEnqueueAlertRemediation({
        ruleId: "rule-1",
        remediationScriptId: SCRIPT_ID,
        assetTag: "PC-1",
      }),
    ).resolves.toBeUndefined();
    expect(H.enqueueMock).toHaveBeenCalled();
  });

  it("swallows enqueue throws", async () => {
    H.enqueueMock.mockRejectedValue(new Error("db down"));
    await expect(
      maybeEnqueueAlertRemediation({
        ruleId: "rule-1",
        remediationScriptId: SCRIPT_ID,
        assetTag: "PC-1",
      }),
    ).resolves.toBeUndefined();
  });
});
