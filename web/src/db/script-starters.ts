import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "./index";
import { createScript } from "./scripts";
import { scripts } from "./schema";

/** Built-in starter scripts for the library (spec 32 polish). */

export type StarterDef = {
  name: string;
  description: string;
  timeoutSeconds: number;
  body: string;
};

export const STARTER_SCRIPTS: StarterDef[] = [
  {
    name: "Reset Print Spooler",
    description: "Stop Spooler, clear the print queue, start Spooler again.",
    timeoutSeconds: 120,
    body: `# Reset Windows Print Spooler
$ErrorActionPreference = "Stop"

try {
    Write-Output "Stopping Print Spooler..."
    Stop-Service -Name Spooler -Force -ErrorAction Stop

    Write-Output "Clearing queued print jobs..."
    $PrinterQueue = "$env:SystemRoot\\System32\\spool\\PRINTERS"
    Get-ChildItem -Path $PrinterQueue -Force -ErrorAction SilentlyContinue |
        Remove-Item -Force -Recurse -ErrorAction SilentlyContinue

    Write-Output "Starting Print Spooler..."
    Start-Service -Name Spooler -ErrorAction Stop
    Start-Sleep -Seconds 2

    $Service = Get-Service -Name Spooler
    Write-Output "Service: $($Service.Name)"
    Write-Output "Status: $($Service.Status)"

    if ($Service.Status -ne "Running") {
        throw "Print Spooler did not reach the Running state (status=$($Service.Status))."
    }

    Write-Output "SUCCESS: Print Spooler reset completed."
}
catch {
    Write-Output "ERROR: $($_.Exception.Message)"
    throw
}
`,
  },
  {
    name: "Free Disk Space",
    description:
      "Clear Windows Temp, Update download cache, and each profile's Local\\Temp. Reports Freed MB.",
    timeoutSeconds: 300,
    body: `$ErrorActionPreference = 'Continue'

try {
    $systemDrive = $env:SystemDrive
    if ([string]::IsNullOrWhiteSpace($systemDrive)) { $systemDrive = 'C:' }
    $driveName = $systemDrive.TrimEnd(':')
    $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
    $before = [int64]$drive.Free
}
catch {
    Write-Output "ERROR: Unable to determine initial free disk space: $($_.Exception.Message)"
    throw
}

$paths = @(
    (Join-Path $env:SystemRoot 'Temp'),
    (Join-Path $env:SystemRoot 'SoftwareDistribution\\Download')
)
if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) { $paths += $env:TEMP }

try {
    $profiles = @(
        Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
            Where-Object {
                $_.LocalPath -and
                -not $_.Special -and
                (Test-Path -LiteralPath $_.LocalPath -PathType Container)
            }
    )
}
catch {
    Write-Output "ERROR: Unable to enumerate local user profiles: $($_.Exception.Message)"
    throw
}

foreach ($profile in $profiles) {
    $paths += (Join-Path $profile.LocalPath 'AppData\\Local\\Temp')
}

$processedPaths = 0
$deletedItems = 0
$failedItems = 0
$skippedPaths = 0
$results = @()

foreach ($path in ($paths | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        $skippedPaths++
        continue
    }
    $processedPaths++
    try {
        $items = @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)
    }
    catch {
        $failedItems++
        $results += [pscustomobject]@{ Path = $path; Status = 'Could not list contents' }
        continue
    }
    foreach ($item in $items) {
        try {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
            $deletedItems++
        }
        catch {
            $failedItems++
            $results += [pscustomobject]@{ Path = $item.FullName; Status = 'Could not delete' }
        }
    }
}

try {
    $after = [int64](Get-PSDrive -Name $driveName -ErrorAction Stop).Free
}
catch {
    Write-Output "ERROR: Cleanup ran, but final free disk space could not be measured: $($_.Exception.Message)"
    throw
}

$freedMB = [math]::Round(($after - $before) / 1MB, 2)
$freeGB = [math]::Round($after / 1GB, 2)

if ($failedItems -gt 0) {
    Write-Output "Sample failures (first 15 of $failedItems):"
    $results | Select-Object -First 15 | ForEach-Object {
        Write-Output ("  {0} - {1}" -f $_.Path, $_.Status)
    }
}

Write-Output "Freed $freedMB MB · $freeGB GB free on $systemDrive"
Write-Output "Profiles=$($profiles.Count) Paths=$processedPaths Deleted=$deletedItems Failed=$failedItems"
if ($failedItems -gt 0) {
    Write-Output "Status=Completed with some failures"
} else {
    Write-Output "Status=Completed"
}
`,
  },
];

export type EnsureStartersResult = {
  added: string[];
  skipped: string[];
};

/** Insert starter scripts that are not already present (by exact name, active). */
export async function ensureStarterScripts(
  actorEmail: string,
): Promise<EnsureStartersResult> {
  const added: string[] = [];
  const skipped: string[] = [];

  for (const s of STARTER_SCRIPTS) {
    const [existing] = await db
      .select({ id: scripts.id })
      .from(scripts)
      .where(and(eq(scripts.name, s.name), isNull(scripts.archivedAt)))
      .limit(1);
    if (existing) {
      skipped.push(s.name);
      continue;
    }
    const res = await createScript({
      name: s.name,
      description: s.description,
      body: s.body,
      timeoutSeconds: s.timeoutSeconds,
      actorEmail,
    });
    if (res.ok) added.push(s.name);
  }

  return { added, skipped };
}
