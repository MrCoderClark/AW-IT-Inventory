import { describe, expect, it } from "vitest";
import { parseSteps } from "./software-package-steps";

describe("parseSteps — skipIf / timeoutSec", () => {
  it("accepts skipIf + timeoutSec on install", () => {
    const r = parseSteps([
      {
        kind: "install",
        name: "UI13",
        installerType: "exe",
        fileName: "a.exe",
        silentArgs: "/S",
        storageKey: "k",
        sha256: "a".repeat(64),
        fileSize: 1,
        timeoutSec: 600,
        skipIf: {
          type: "product_installed",
          displayName: "ePadLink ePad",
          displayNameMatch: "eq",
        },
      },
    ]);
    expect("steps" in r).toBe(true);
    if (!("steps" in r)) return;
    const s = r.steps[0];
    expect(s.kind).toBe("install");
    if (s.kind !== "install") return;
    expect(s.timeoutSec).toBe(600);
    expect(s.skipIf).toEqual({
      type: "product_installed",
      displayName: "ePadLink ePad",
      displayNameMatch: "eq",
    });
  });

  it("rejects unknown skipIf.type", () => {
    const r = parseSteps([
      {
        kind: "script",
        name: "x",
        script: "Write-Output 1",
        skipIf: { type: "nope", displayName: "X" },
      },
    ]);
    expect("error" in r).toBe(true);
  });

  it("rejects empty displayName", () => {
    const r = parseSteps([
      {
        kind: "script",
        name: "x",
        script: "Write-Output 1",
        skipIf: { type: "product_installed", displayName: "  " },
      },
    ]);
    expect("error" in r).toBe(true);
  });

  it("rejects non-positive timeoutSec", () => {
    const r = parseSteps([
      {
        kind: "script",
        name: "x",
        script: "Write-Output 1",
        timeoutSec: 0,
      },
    ]);
    expect("error" in r).toBe(true);
  });
});
