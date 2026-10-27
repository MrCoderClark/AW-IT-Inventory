import { randomUUID } from "node:crypto";

import type { SoftwareStep, SoftwareStepSkipIf } from "@/db/schema";

/**
 * Validate + normalize the raw `steps` from a package create/edit request into
 * `SoftwareStep[]` (spec 23). Step ids are assigned here so they're stable in the
 * frozen deploy snapshot. Shared by POST (create) and PUT (edit).
 */
export type ParsedSteps = { steps: SoftwareStep[] } | { error: string };

function parseTimeoutSec(
  raw: unknown,
  stepLabel: string,
): { timeoutSec?: number } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
    return { error: `${stepLabel}: timeoutSec must be a positive number` };
  return { timeoutSec: Math.floor(raw) };
}

function parseSkipIf(
  raw: unknown,
  stepLabel: string,
): { skipIf?: SoftwareStepSkipIf } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || raw === null)
    return { error: `${stepLabel}: skipIf is malformed` };
  const o = raw as Record<string, unknown>;
  if (o.type !== "product_installed")
    return { error: `${stepLabel}: skipIf.type must be product_installed` };
  const displayName = typeof o.displayName === "string" ? o.displayName.trim() : "";
  if (!displayName) return { error: `${stepLabel}: skipIf.displayName is required` };
  const displayNameMatch = o.displayNameMatch === "prefix" ? "prefix" : "eq";
  const displayVersion =
    typeof o.displayVersion === "string" && o.displayVersion.trim()
      ? o.displayVersion.trim()
      : undefined;
  return {
    skipIf: {
      type: "product_installed",
      displayName,
      displayNameMatch,
      ...(displayVersion ? { displayVersion } : {}),
    },
  };
}

export function parseSteps(raw: unknown): ParsedSteps {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "add at least one step" };

  const steps: SoftwareStep[] = [];
  for (const [i, s] of raw.entries()) {
    if (typeof s !== "object" || s === null)
      return { error: `step ${i + 1} is malformed` };
    const step = s as Record<string, unknown>;
    const name = typeof step.name === "string" ? step.name.trim() : "";
    const continueOnError = step.continueOnError === true;
    const id = randomUUID();

    const stepLabel = `step ${i + 1}`;
    const timeout = parseTimeoutSec(step.timeoutSec, stepLabel);
    if ("error" in timeout) return timeout;
    const skip = parseSkipIf(step.skipIf, stepLabel);
    if ("error" in skip) return skip;

    if (step.kind === "script") {
      const script = typeof step.script === "string" ? step.script : "";
      if (!script.trim()) return { error: `${stepLabel}: the script is empty` };
      steps.push({
        id,
        kind: "script",
        name: name || `Script step ${i + 1}`,
        script,
        continueOnError,
        ...timeout,
        ...skip,
      });
    } else if (step.kind === "install") {
      const installerType = step.installerType === "exe" ? "exe" : "msi";
      const fileName = typeof step.fileName === "string" ? step.fileName : "";
      const storageKey = typeof step.storageKey === "string" ? step.storageKey : "";
      const sha256 = typeof step.sha256 === "string" ? step.sha256 : "";
      const fileSize = typeof step.fileSize === "number" ? step.fileSize : 0;
      const silentArgs =
        typeof step.silentArgs === "string" ? step.silentArgs.trim() : "";
      if (!storageKey || !sha256 || !fileName)
        return { error: `step ${i + 1}: upload the installer file first` };
      if (installerType === "exe" && !silentArgs)
        return {
          error: `step ${i + 1}: EXE installers need silent arguments (e.g. /S)`,
        };
      const rawCompanions = Array.isArray(step.companions) ? step.companions : [];
      const companions = [];
      for (const c of rawCompanions) {
        if (typeof c !== "object" || c === null) continue;
        const cc = c as Record<string, unknown>;
        if (
          typeof cc.storageKey !== "string" ||
          typeof cc.sha256 !== "string" ||
          typeof cc.fileName !== "string"
        )
          return { error: `step ${i + 1}: a companion file is incomplete` };
        companions.push({
          storageKey: cc.storageKey,
          sha256: cc.sha256,
          fileName: cc.fileName,
          fileSize: typeof cc.fileSize === "number" ? cc.fileSize : 0,
        });
      }
      steps.push({
        id,
        kind: "install",
        name: name || fileName,
        installerType,
        fileName,
        silentArgs,
        sha256,
        storageKey,
        fileSize,
        ...(companions.length ? { companions } : {}),
        continueOnError,
        ...timeout,
        ...skip,
      });
    } else {
      return { error: `step ${i + 1}: unknown step type` };
    }
  }
  return { steps };
}
