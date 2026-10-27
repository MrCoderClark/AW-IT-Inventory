import { describe, expect, it } from "vitest";

import { PACKAGE_TEMPLATES } from "./software-package-templates";

it("includes netfx, chrome-edge, installshield presets", () => {
  expect(PACKAGE_TEMPLATES.map((t) => t.id).sort()).toEqual(
    ["chrome-edge-extension", "enable-netfx35", "installshield-uninstall-install"].sort(),
  );
});

describe("enable-netfx35", () => {
  it("embeds idempotent NetFx3 optional-feature script", () => {
    const t = PACKAGE_TEMPLATES.find((x) => x.id === "enable-netfx35");
    expect(t).toBeDefined();
    const steps = t!.buildSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("script");
    if (steps[0].kind !== "script") return;
    expect(steps[0].script).toContain("NetFx3");
    expect(steps[0].script).toContain("Enable-WindowsOptionalFeature");
  });
});

describe("chrome-edge-extension", () => {
  it("uses literal JSON ExtensionSettings for Chrome and Edge", () => {
    const t = PACKAGE_TEMPLATES.find((x) => x.id === "chrome-edge-extension");
    const script = t!.buildSteps()[0];
    expect(script.kind).toBe("script");
    if (script.kind !== "script") return;
    expect(script.script).toContain('@"');
    expect(script.script).toContain("normal_installed");
    expect(script.script).not.toContain("ConvertTo-Json");
    expect(script.script).toContain("Policies\\Google\\Chrome");
    expect(script.script).toContain("Policies\\Microsoft\\Edge");
    expect(script.script).toContain("idldbjenlmipmpigmfamdlfifkkeaplc");
  });
});

describe("installshield-uninstall-install", () => {
  it("adds uninstall (continueOnError) then install stubs", () => {
    const steps = PACKAGE_TEMPLATES.find(
      (x) => x.id === "installshield-uninstall-install",
    )!.buildSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0].kind).toBe("install");
    expect(steps[1].kind).toBe("install");
    if (steps[0].kind !== "install" || steps[1].kind !== "install") return;
    expect(steps[0].silentArgs).toBe('/s /f1"%DIR%\\uninstall.iss"');
    expect(steps[0].continueOnError).toBe(true);
    expect(steps[1].silentArgs).toBe('/s /f1"%DIR%\\install.iss" /v"/qn"');
    expect(steps[1].skipIfEnabled).toBe(false);
    expect(steps[0].storageKey).toBe("");
    expect(steps[1].storageKey).toBe("");
  });
});
