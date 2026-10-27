/** Default per-step timeout (seconds) — matches package editor. */
const DEFAULT_STEP_TIMEOUT_SEC = 900;

type EditorStepBasePartial = {
  timeoutSec: number;
  skipIfEnabled: boolean;
  skipIfDisplayName: string;
  skipIfMatch: "eq" | "prefix";
  skipIfVersion: string;
  continueOnError: boolean;
};

type CompanionFilePartial = {
  fileName: string;
  storageKey: string;
  sha256: string;
  fileSize: number;
  uploading: boolean;
};

export type EditorStepPartial =
  | ({
      kind: "script";
      name: string;
      script: string;
    } & EditorStepBasePartial)
  | ({
      kind: "install";
      name: string;
      installerType: "msi" | "exe";
      fileName: string;
      silentArgs: string;
      sha256: string;
      storageKey: string;
      fileSize: number;
      uploading: boolean;
      companions: CompanionFilePartial[];
    } & EditorStepBasePartial);

function defaultStepFields(
  overrides: Partial<EditorStepBasePartial> = {},
): EditorStepBasePartial {
  return {
    timeoutSec: DEFAULT_STEP_TIMEOUT_SEC,
    skipIfEnabled: false,
    skipIfDisplayName: "",
    skipIfMatch: "eq",
    skipIfVersion: "",
    continueOnError: false,
    ...overrides,
  };
}

function installStub(
  name: string,
  silentArgs: string,
  fields: Partial<EditorStepBasePartial> = {},
): EditorStepPartial {
  return {
    kind: "install",
    name,
    installerType: "exe",
    fileName: "",
    silentArgs,
    sha256: "",
    storageKey: "",
    fileSize: 0,
    uploading: false,
    companions: [],
    ...defaultStepFields(fields),
  };
}

const NETFX35_SCRIPT = `$state = (Get-WindowsOptionalFeature -Online -FeatureName NetFx3).State

if ($state -ne 'Enabled') {
    Enable-WindowsOptionalFeature -Online -FeatureName NetFx3 -All -NoRestart
} else {
    Write-Output ".NET Framework 3.5 is already enabled."
}
`;

const CHROME_EDGE_EXTENSION_SCRIPT = `$ErrorActionPreference = 'Stop'
$extId = 'idldbjenlmipmpigmfamdlfifkkeaplc'
$updateUrl = 'https://clients2.google.com/service/update2/crx'

$settings = @"
{"$extId":{"installation_mode":"normal_installed","update_url":"$updateUrl"}}
"@

# --- Chrome ---
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist' -Recurse -Force -ErrorAction SilentlyContinue

$chromePol = 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome'
New-Item -Path $chromePol -Force | Out-Null

New-ItemProperty -Path $chromePol -Name 'ExtensionSettings' -PropertyType String -Value $settings -Force | Out-Null

# --- Edge (same Chrome Web Store extension) ---
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist' -Recurse -Force -ErrorAction SilentlyContinue

$edgePol = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge'
New-Item -Path $edgePol -Force | Out-Null

New-ItemProperty -Path $edgePol -Name 'ExtensionSettings' -PropertyType String -Value $settings -Force | Out-Null

Write-Output "ExtensionSettings=$settings"
Write-Output 'Fully quit Chrome and Edge, then:'
Write-Output '  chrome://policy -> Reload policies'
Write-Output '  edge://policy -> Reload policies'
Write-Output 'If an extension still shows locked, remove it once and reopen the browser (may take a minute to reappear).'
`;

export type PackageTemplate = {
  id: string;
  label: string;
  description: string;
  buildSteps: () => EditorStepPartial[];
};

export const PACKAGE_TEMPLATES: PackageTemplate[] = [
  {
    id: "enable-netfx35",
    label: "Enable .NET 3.5",
    description: "Idempotent NetFx3 optional feature (InstallShield prerequisite).",
    buildSteps: () => [
      {
        kind: "script",
        name: "Enable .NET 3.5",
        script: NETFX35_SCRIPT,
        ...defaultStepFields(),
      },
    ],
  },
  {
    id: "chrome-edge-extension",
    label: "Chrome + Edge ePad extension",
    description:
      "SigCaptureWeb extension via ExtensionSettings (normal_installed, literal JSON).",
    buildSteps: () => [
      {
        kind: "script",
        name: "Chrome + Edge ePad extension",
        script: CHROME_EDGE_EXTENSION_SCRIPT,
        ...defaultStepFields(),
      },
    ],
  },
  {
    id: "installshield-uninstall-install",
    label: "InstallShield uninstall + install",
    description:
      "Two EXE steps with .iss companions — upload installer and response files for each.",
    buildSteps: () => [
      installStub("Uninstall (InstallShield)", '/s /f1"%DIR%\\uninstall.iss"', {
        continueOnError: true,
      }),
      installStub("Install (InstallShield)", '/s /f1"%DIR%\\install.iss" /v"/qn"'),
    ],
  },
];
