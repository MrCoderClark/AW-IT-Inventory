import { describe, expect, it } from "vitest";

import type { SoftwareStep } from "@/db/schema";
import { buildExportPs1 } from "./software-export-script";

const baseSteps: SoftwareStep[] = [
  {
    id: "step-install",
    kind: "install",
    name: "Install ePad",
    installerType: "exe",
    fileName: "setup.exe",
    silentArgs: '/s /f1"%DIR%\\app.iss" /v"/qn"',
    sha256: "a".repeat(64),
    storageKey: "software/pkg/setup.exe",
    fileSize: 100,
    skipIf: {
      type: "product_installed",
      displayName: "ePadLink ePad",
      displayNameMatch: "prefix",
    },
  },
];

const baseFiles = [
  {
    fileName: "setup.exe",
    url: "https://h2tecs.example/api/software/packages/p1/export-file?file=setup.exe&exp=1&sig=abc",
    sha256: "a".repeat(64),
  },
];

function build(overrides?: {
  steps?: SoftwareStep[];
  files?: typeof baseFiles;
  aiComments?: string;
}) {
  return buildExportPs1({
    packageName: "ePad Client",
    version: "2.1.0",
    baseUrl: "https://h2tecs.example",
    steps: overrides?.steps ?? baseSteps,
    files: overrides?.files ?? baseFiles,
    aiComments: overrides?.aiComments,
  });
}

describe("buildExportPs1", () => {
  it("requires elevation and names the package", () => {
    const ps1 = build();
    expect(ps1).toContain("#Requires -RunAsAdministrator");
    expect(ps1).toContain("ePad Client");
    expect(ps1).toContain("2.1.0");
    expect(ps1).toContain(
      '$WorkDir = Join-Path $env:TEMP ("h2tecs-export-" + [guid]::NewGuid())',
    );
  });

  it("embeds signed download URLs and optional sha256 verification", () => {
    const ps1 = build();
    expect(ps1).toContain(baseFiles[0].url);
    expect(ps1).toContain("Invoke-WebRequest");
    expect(ps1).toContain("Get-FileHash");
    expect(ps1).toContain("a".repeat(64));
  });

  it("embeds skipIf Uninstall probe with displayName", () => {
    const ps1 = build();
    expect(ps1).toContain("Uninstall\\*");
    expect(ps1).toContain("ePadLink ePad");
    expect(ps1).toContain("prefix");
    expect(ps1).toContain("skipIf: product_installed");
  });

  it("replaces %DIR% with the work directory variable for install steps", () => {
    const ps1 = build();
    expect(ps1).not.toContain("%DIR%");
    expect(ps1).toMatch(/\$WorkDir.*app\.iss/);
  });

  it("writes script steps to a ps1 file and invokes them", () => {
    const ps1 = build({
      steps: [
        {
          id: "step-script",
          kind: "script",
          name: "Enable feature",
          script: "Write-Output 'ok'",
        },
      ],
      files: [],
    });
    expect(ps1).toContain("step-script.ps1");
    expect(ps1).toContain("Write-Output ''ok''");
    expect(ps1).toMatch(/& .*step-script\.ps1/);
  });

  it("prefixes optional AI commentary as comment lines only", () => {
    const ps1 = build({ aiComments: "Run during maintenance.\nReboot if prompted." });
    expect(ps1).toContain("# Run during maintenance.");
    expect(ps1).toContain("# Reboot if prompted.");
    expect(ps1).not.toMatch(/^Run during/m);
  });

  it("exits 1 when a non-continuing step fails", () => {
    const ps1 = build();
    expect(ps1).toContain("exit 1");
  });

  it("continueOnError steps warn instead of exit 1 inside try", () => {
    const ps1 = build({
      steps: [
        {
          id: "step-uninstall",
          kind: "install",
          name: "Uninstall prior",
          installerType: "exe",
          fileName: "uninstall.exe",
          silentArgs: "/S",
          sha256: "b".repeat(64),
          storageKey: "software/uninstall.exe",
          fileSize: 50,
          continueOnError: true,
        },
        {
          id: "step-install",
          kind: "install",
          name: "Install ePad",
          installerType: "exe",
          fileName: "setup.exe",
          silentArgs: "/S",
          sha256: "a".repeat(64),
          storageKey: "software/pkg/setup.exe",
          fileSize: 100,
        },
      ],
      files: [
        ...baseFiles,
        {
          fileName: "uninstall.exe",
          url: "https://h2tecs.example/uninstall.exe",
          sha256: "b".repeat(64),
        },
      ],
    });
    const uninstallTry = ps1.match(
      /try \{[\s\S]*?Uninstall prior[\s\S]*?\} catch/,
    );
    expect(uninstallTry).toBeTruthy();
    expect(uninstallTry![0]).not.toContain("exit 1");
    expect(uninstallTry![0]).toContain("Write-Warning");
    expect(ps1).toContain("Step: Install ePad");
  });
});
