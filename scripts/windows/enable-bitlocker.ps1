# enable-bitlocker.ps1
# Enable BitLocker on the system drive of a domain-joined Windows computer,
# escrow the recovery password to Active Directory, and emit a structured JSON
# result for H2Tecs ingest.
#
# Scope: C: only. By design this script does not touch D:, E:, or any other
# volume - data drives, removable media, and non-system volumes are out of
# scope for v1 (see spec 35).
#
# Params:
#   -EncryptionMethod XtsAes128 (default) or XtsAes256.
#   -UsedSpaceOnly    Switch. Encrypt used space only (faster on new machines).
#   -AllowNoTpm       Switch. Allow enablement without a TPM (not recommended).
#   -SkipAdBackup     Switch. Skip AD escrow. Lab/testing only.
#
# Exit codes:
#    0  success (encryption already on, or enablement started)
#   10  not domain-joined - refusing
#   11  TPM missing or not ready (and -AllowNoTpm not set)
#   12  BitLocker module unavailable
#   13  Enable-BitLocker failed
#   14  All AD backups failed (hard failure - key only lives locally)
#    1  unexpected error
#
# Output: one line on stdout, "H2TECS_BITLOCKER_RESULT <json>". The collector
# scrapes this line out of interleaved WinRM output and posts the payload to
# POST /api/ingest/bitlocker (spec 35).

#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [ValidateSet('XtsAes128', 'XtsAes256')]
    [string]$EncryptionMethod = 'XtsAes128',
    [switch]$UsedSpaceOnly,
    [switch]$AllowNoTpm,
    [switch]$SkipAdBackup
)

$ErrorActionPreference = 'Stop'

# Hardcoded: v1 only ever operates on the C: system drive.
$MountPoint = 'C:'

function Write-Result {
    param([hashtable]$Result, [int]$ExitCode = 0)
    $json = $Result | ConvertTo-Json -Depth 6 -Compress
    Write-Output "H2TECS_BITLOCKER_RESULT $json"
    exit $ExitCode
}

$result = @{
    schema            = 'h2tecs.bitlocker.v1'
    hostname          = $env:COMPUTERNAME
    domain            = $null
    domain_joined     = $false
    mount_point       = $MountPoint
    tpm               = @{ present = $false; ready = $false }
    encryption_method = $null
    protection_status = $null
    volume_status     = $null
    encryption_pct    = $null
    already_encrypted = $false
    enabled_now       = $false
    key_protectors    = @()
    error             = $null
    timestamp_utc     = (Get-Date).ToUniversalTime().ToString('o')
}

try {
    # 1. Domain membership
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem
    $result.domain_joined = [bool]$cs.PartOfDomain
    $result.domain        = $cs.Domain
    if (-not $cs.PartOfDomain) {
        $result.error = 'not domain-joined; refusing to enable BitLocker'
        Write-Result -Result $result -ExitCode 10
    }

    # 2. BitLocker module available?
    if (-not (Get-Command -Name Get-BitLockerVolume -ErrorAction SilentlyContinue)) {
        $result.error = 'BitLocker PowerShell module not available on this host'
        Write-Result -Result $result -ExitCode 12
    }

    # 3. TPM check
    try {
        $tpm = Get-Tpm -ErrorAction Stop
        $result.tpm.present = [bool]$tpm.TpmPresent
        $result.tpm.ready   = [bool]$tpm.TpmReady
    } catch {
        $result.tpm.present = $false
        $result.tpm.ready   = $false
    }
    if (-not ($result.tpm.present -and $result.tpm.ready) -and -not $AllowNoTpm) {
        $result.error = 'TPM missing or not ready; pass -AllowNoTpm to override'
        Write-Result -Result $result -ExitCode 11
    }

    # 4. Current BitLocker state
    $vol = Get-BitLockerVolume -MountPoint $MountPoint
    $result.protection_status = [string]$vol.ProtectionStatus
    $result.volume_status     = [string]$vol.VolumeStatus
    $result.encryption_pct    = [int]$vol.EncryptionPercentage
    $result.encryption_method = [string]$vol.EncryptionMethod

    $fullyEncrypted = ($vol.VolumeStatus -eq 'FullyEncrypted') -or
                      ($vol.ProtectionStatus -eq 'On' -and $vol.EncryptionPercentage -eq 100)
    $result.already_encrypted = $fullyEncrypted

    # 5. Enable if needed
    if (-not $fullyEncrypted -and $vol.VolumeStatus -eq 'FullyDecrypted') {
        $enableParams = @{
            MountPoint                = $MountPoint
            EncryptionMethod          = $EncryptionMethod
            TpmProtector              = $true
            RecoveryPasswordProtector = $true
            SkipHardwareTest          = $true
        }
        if ($UsedSpaceOnly) { $enableParams.UsedSpaceOnly = $true }
        try {
            # *> $null swallows every stream, including the "ACTIONS REQUIRED:
            # save this recovery key" banner the cmdlet prints to the console.
            # This script writes the key to AD + the ingest payload; the
            # operator-facing manual-save banner is noise in that flow.
            Enable-BitLocker @enableParams *> $null
            $result.enabled_now = $true
        } catch {
            $result.error = "Enable-BitLocker failed: $($_.Exception.Message)"
            Write-Result -Result $result -ExitCode 13
        }
        $vol = Get-BitLockerVolume -MountPoint $MountPoint
        $result.protection_status = [string]$vol.ProtectionStatus
        $result.volume_status     = [string]$vol.VolumeStatus
        $result.encryption_pct    = [int]$vol.EncryptionPercentage
        $result.encryption_method = [string]$vol.EncryptionMethod
    }
    elseif (-not ($vol.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' })) {
        # Already encrypting/encrypted but no recovery-password protector exists.
        # Add one so there is something to escrow.
        Add-BitLockerKeyProtector -MountPoint $MountPoint -RecoveryPasswordProtector *> $null
        $vol = Get-BitLockerVolume -MountPoint $MountPoint
    }

    # 6. Enumerate protectors + AD escrow
    $adBackupTargetCount = 0
    $adBackupOkCount     = 0
    foreach ($kp in $vol.KeyProtector) {
        $entry = [ordered]@{
            id   = [string]$kp.KeyProtectorId
            type = [string]$kp.KeyProtectorType
        }
        if ($kp.KeyProtectorType -eq 'RecoveryPassword') {
            $entry.recovery_password = [string]$kp.RecoveryPassword
            $entry.ad_backup         = 'skipped'
            if (-not $SkipAdBackup) {
                $adBackupTargetCount++
                try {
                    Backup-BitLockerKeyProtector -MountPoint $MountPoint `
                        -KeyProtectorId $kp.KeyProtectorId -ErrorAction Stop | Out-Null
                    $entry.ad_backup = 'ok'
                    $adBackupOkCount++
                } catch {
                    $entry.ad_backup       = 'failed'
                    $entry.ad_backup_error = $_.Exception.Message
                }
            }
        }
        $result.key_protectors += [pscustomobject]$entry
    }

    # If AD backup was requested but every attempt failed, hard-fail so the
    # operator sees it instead of believing the key is safe.
    if (-not $SkipAdBackup -and $adBackupTargetCount -gt 0 -and $adBackupOkCount -eq 0) {
        $firstReason = ($result.key_protectors |
            Where-Object { $_.type -eq 'RecoveryPassword' -and $_.ad_backup -eq 'failed' } |
            Select-Object -First 1 -ExpandProperty ad_backup_error)
        $result.error = "AD backup failed for every recovery-password protector: $firstReason"
        # Human-readable line on stderr so the operator sees the real reason
        # in a terminal without having to parse the JSON payload.
        [Console]::Error.WriteLine('')
        [Console]::Error.WriteLine('AD backup FAILED. BitLocker is enabled locally but the recovery')
        [Console]::Error.WriteLine('key is NOT in Active Directory. Reason:')
        [Console]::Error.WriteLine("  $firstReason")
        [Console]::Error.WriteLine('')
        [Console]::Error.WriteLine('Usual fix: enable the GPO')
        [Console]::Error.WriteLine('  Computer Configuration > Administrative Templates > Windows Components')
        [Console]::Error.WriteLine('    > BitLocker Drive Encryption > Operating System Drives')
        [Console]::Error.WriteLine('    > "Choose how BitLocker-protected operating system drives')
        [Console]::Error.WriteLine('       can be recovered"')
        [Console]::Error.WriteLine('  check "Save BitLocker recovery information to AD DS",')
        [Console]::Error.WriteLine('  run gpupdate /force on the target, then re-run this script.')
        [Console]::Error.WriteLine('')
        Write-Result -Result $result -ExitCode 14
    }

    Write-Result -Result $result -ExitCode 0
}
catch {
    $result.error = "unexpected error: $($_.Exception.Message)"
    Write-Result -Result $result -ExitCode 1
}
