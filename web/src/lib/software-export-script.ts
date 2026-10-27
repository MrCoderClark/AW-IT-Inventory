import type { SoftwareStep, SoftwareStepSkipIf } from "@/db/schema";

export type ExportPs1File = {
  fileName: string;
  url: string;
  sha256?: string;
};

export type BuildExportPs1Opts = {
  packageName: string;
  version: string;
  baseUrl: string;
  steps: SoftwareStep[];
  files: ExportPs1File[];
  aiComments?: string;
};

/** Escape for inclusion inside a PowerShell single-quoted string. */
function psQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function commentLines(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\r?\n/)
    .map((line) => `# ${line}`);
}

function emitSkipIfProbe(skip: SoftwareStepSkipIf): string[] {
  const name = skip.displayName.replace(/'/g, "''");
  const match = skip.displayNameMatch ?? "eq";
  const ver = (skip.displayVersion ?? "").replace(/'/g, "''");
  return [
    `$__skipName = '${name}'`,
    `$__skipMatch = '${match}'`,
    `$__skipVer = '${ver}'`,
    `$__skipFound = $false`,
    `$__skipPaths = @(`,
    `  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',`,
    `  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'`,
    `)`,
    `foreach ($__p in $__skipPaths) {`,
    `  Get-ItemProperty $__p -ErrorAction SilentlyContinue | ForEach-Object {`,
    `    $__dn = $_.DisplayName`,
    `    if (-not $__dn) { return }`,
    `    $__nameOk = if ($__skipMatch -eq 'prefix') { $__dn.StartsWith($__skipName) } else { $__dn -eq $__skipName }`,
    `    if (-not $__nameOk) { return }`,
    `    if ($__skipVer -ne '') {`,
    `      if ($_.DisplayVersion -ne $__skipVer) { return }`,
    `    }`,
    `    $__skipFound = $true`,
    `  }`,
    `}`,
  ];
}

function psEscapeDouble(value: string): string {
  return value.replace(/"/g, '`"');
}

const WRITE_RUN_BAT =
  '[IO.File]::WriteAllText($__bat, "@echo off`r`n$__cmd`r`n")';

function psQuotedInstallerPath(fileName: string): string {
  return '`"' + '$WorkDir\\' + psEscapeDouble(fileName) + '`"';
}

function emitFailureHandling(
  stepLabel: string,
  continueOnError: boolean,
  treat3010AsSuccess: boolean,
): string[] {
  const cond = treat3010AsSuccess
    ? "$__exit -ne 0 -and $__exit -ne 3010"
    : "$__exit -ne 0";
  if (continueOnError) {
    return [
      `if (${cond}) {`,
      `  Write-Warning "Step continued after non-zero exit: ${stepLabel} (exit $__exit)"`,
      `}`,
    ];
  }
  return [
    `if (${cond}) {`,
    `  Write-Error "Step failed: ${stepLabel} (exit $__exit)"`,
    `  exit 1`,
    `}`,
  ];
}

function emitInstallRun(
  step: Extract<SoftwareStep, { kind: "install" }>,
  continueOnError: boolean,
): string[] {
  const silent = step.silentArgs.replace(/%DIR%/g, "$WorkDir");
  const stepLabel = psEscapeDouble(step.name);
  const lines: string[] = [];
  if (step.installerType === "msi") {
    const args = silent.trim() || "/qn /norestart";
    lines.push(
      '$__cmd = "msiexec /i ' +
        psQuotedInstallerPath(step.fileName) +
        " " +
        psEscapeDouble(args) +
        '"',
      `$__bat = Join-Path $WorkDir 'h2tecs_run.cmd'`,
      WRITE_RUN_BAT,
      `cmd.exe /c $__bat`,
      `$__exit = $LASTEXITCODE`,
    );
  } else {
    // silentArgs often contain quotes (InstallShield /f1"…" /v"/qn") — escape
    // them so they survive inside the $__cmd = "…" double-quoted PowerShell string.
    lines.push(
      '$__cmd = "' +
        psQuotedInstallerPath(step.fileName) +
        " " +
        psEscapeDouble(silent) +
        '"',
      `$__bat = Join-Path $WorkDir 'h2tecs_run.cmd'`,
      WRITE_RUN_BAT,
      `cmd.exe /c $__bat`,
      `$__exit = $LASTEXITCODE`,
    );
  }
  lines.push(...emitFailureHandling(stepLabel, continueOnError, true));
  return lines;
}

function emitScriptRun(
  step: Extract<SoftwareStep, { kind: "script" }>,
  continueOnError: boolean,
): string[] {
  // Embed as Base64 so Unicode (e.g. →) and quotes in the step never break the
  // parent .ps1 under Windows PowerShell's default ANSI file encoding.
  const b64 = Buffer.from(step.script, "utf8").toString("base64");
  const scriptFile = `${step.id}.ps1`;
  const scriptPath = `(Join-Path $WorkDir ${psQuoteSingle(scriptFile)})`;
  return [
    `$__script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuoteSingle(b64)}))`,
    // UTF-8 BOM so Windows PowerShell 5.1 does not re-parse Unicode as ANSI
    `[IO.File]::WriteAllText(${scriptPath}, $__script, (New-Object System.Text.UTF8Encoding $true))`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `& ${scriptPath}`,
    `$__exit = $LASTEXITCODE`,
    ...emitFailureHandling(psEscapeDouble(step.name), continueOnError, false),
  ];
}

function emitStep(step: SoftwareStep): string[] {
  const lines: string[] = [
    ``,
    `Write-Host ${psQuoteSingle(`Step: ${step.name}`)}`,
  ];

  const cont = Boolean(step.continueOnError);
  const runBody =
    step.kind === "script" ? emitScriptRun(step, cont) : emitInstallRun(step, cont);

  if (step.skipIf?.type === "product_installed") {
    lines.push(...emitSkipIfProbe(step.skipIf));
    lines.push(`if ($__skipFound) {`);
    lines.push(`  Write-Host 'skipIf: product_installed'`);
    lines.push(`} else {`);
    lines.push(...runBody.map((l) => `  ${l}`));
    lines.push(`}`);
  } else {
    lines.push(...runBody);
  }

  if (step.continueOnError) {
    return wrapContinueOnError(lines, step.name);
  }
  return lines;
}

function wrapContinueOnError(lines: string[], stepName: string): string[] {
  const safeName = psEscapeDouble(stepName);
  return [
    `try {`,
    ...lines.map((l) => `  ${l}`),
    `} catch {`,
    `  Write-Warning "Step continued after error: ${safeName}: $_"`,
    `}`,
  ];
}

function emitDownloads(files: ExportPs1File[]): string[] {
  if (files.length === 0) return [];
  // Defense in depth: one download per staging fileName (caller should already dedupe).
  const seen = new Set<string>();
  // Invoke-WebRequest progress UI is extremely slow on Windows PowerShell 5.1;
  // WebClient.DownloadFile streams without that tax. Prefer curl.exe when present.
  const lines: string[] = [
    `Write-Host 'Downloading package files...'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$__wc = New-Object System.Net.WebClient`,
  ];
  for (const file of files) {
    const name = file.fileName.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const urlLit = psQuoteSingle(file.url);
    const nameLit = psQuoteSingle(name);
    lines.push(
      `$__out = Join-Path $WorkDir ${nameLit}`,
      `Write-Host ('  ' + ${nameLit})`,
      `if (Get-Command curl.exe -ErrorAction SilentlyContinue) {`,
      `  & curl.exe -fsSL --retry 3 -o $__out ${urlLit}`,
      `  if ($LASTEXITCODE -ne 0) { throw "download failed: ${psEscapeDouble(name)}" }`,
      `} else {`,
      `  $__wc.DownloadFile(${urlLit}, $__out)`,
      `}`,
    );
    if (file.sha256?.trim()) {
      const expected = file.sha256.trim().toLowerCase();
      lines.push(
        `$__hash = (Get-FileHash -Path $__out -Algorithm SHA256).Hash.ToLower()`,
        `if ($__hash -ne ${psQuoteSingle(expected)}) {`,
        `  Write-Error "integrity check failed for ${psEscapeDouble(name)}"`,
        `  exit 1`,
        `}`,
      );
    }
  }
  lines.push(`$__wc.Dispose()`);
  return lines;
}

/** Build a standalone elevated PowerShell install script for break-glass export. */
export function buildExportPs1(opts: BuildExportPs1Opts): string {
  const header = [
    `#Requires -RunAsAdministrator`,
    `# H2Tecs break-glass export: ${opts.packageName} v${opts.version}`,
    `# Base URL: ${opts.baseUrl}`,
    ...commentLines(opts.aiComments),
    ``,
    `$ErrorActionPreference = 'Stop'`,
    `$WorkDir = Join-Path $env:TEMP ("h2tecs-export-" + [guid]::NewGuid())`,
    `New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null`,
    `Write-Host "Work directory: $WorkDir"`,
  ];

  const downloads = emitDownloads(opts.files);
  const steps = opts.steps.flatMap((step) => emitStep(step));

  const footer = [
    ``,
    `Write-Host 'Package completed successfully.'`,
  ];

  return [...header, ...downloads, ...steps, ...footer].join("\n");
}
