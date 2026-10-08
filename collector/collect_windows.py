"""Windows collection over WinRM: one PowerShell call returns CIM data as JSON.

Tries each candidate credential profile until one authenticates; records which
profile worked (so a future run can go straight to it).
"""

from __future__ import annotations

import json

import winrm

from config import Config, CredentialProfile
from models import Compliance, Disk, Hardware, Health, LocalAdmin, Software

# Single round-trip: gather hardware + OS/health and emit compact JSON.
PS_COLLECT = r"""
$ErrorActionPreference = 'SilentlyContinue'
$cs   = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$prod = Get-CimInstance Win32_ComputerSystemProduct
$os   = Get-CimInstance Win32_OperatingSystem
$cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1
$ram  = (Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum
$gpu  = (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name
$disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
    @{ model = $_.Model; size_gb = [math]::Round($_.Size/1GB, 1); media_type = "$($_.MediaType)" } })
$free = @{}
foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")) {
    $free["$($d.DeviceID)"] = [math]::Round($d.FreeSpace/1GB, 1) }
$uptime = if ($os.LastBootUpTime) { ((Get-Date) - $os.LastBootUpTime).TotalHours } else { $null }
# Installed programs from the registry Uninstall keys (spec 15): HKLM 64-bit, HKLM
# WOW6432Node (32-bit on 64-bit Windows), and HKCU (per-user installs). Never
# Win32_Product (slow, can trigger MSI repair). Best-effort — SilentlyContinue
# skips a hive that isn't present in this session.
$swPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
$sw = @(Get-ItemProperty $swPaths | Where-Object { $_.DisplayName } | ForEach-Object {
    @{ name = "$($_.DisplayName)"; version = "$($_.DisplayVersion)"; publisher = "$($_.Publisher)"; install_date = "$($_.InstallDate)" } })
[ordered]@{
    hostname       = $cs.DNSHostName
    manufacturer   = $cs.Manufacturer
    model          = $cs.Model
    serial         = $bios.SerialNumber
    hardware_uuid  = $prod.UUID
    cpu            = $cpu.Name
    cpu_cores      = $cpu.NumberOfCores
    ram_gb         = [math]::Round($ram/1GB, 1)
    gpu            = $gpu
    bios_version   = $bios.SMBIOSBIOSVersion
    disks          = $disks
    os_name        = $os.Caption
    os_version     = $os.Version
    os_build       = $os.BuildNumber
    uptime_hours   = if ($uptime) { [math]::Round($uptime, 1) } else { $null }
    free_disk_gb   = $free
    logged_on_user = $cs.UserName
    software       = $sw
} | ConvertTo-Json -Depth 5 -Compress
"""

# Security posture (spec 21) runs as a SECOND, small WinRM call — pywinrm sends a
# run_ps script as `powershell -EncodedCommand <b64>` on the WinRS command line
# (~8 KB cap, UTF-16+base64 ≈ 2.67x), and folding posture into PS_COLLECT pushed it
# over ("The command line is too long"). Kept separate, each script stays well
# under. Best-effort: every signal is $null on failure (an unreadable BitLocker/TPM
# on a UAC-filtered token reads as "unknown"), and the whole call is optional —
# collect_windows runs it only after the hardware collect already succeeded.
PS_POSTURE = r"""
$ErrorActionPreference = 'SilentlyContinue'
$bl = $null; try { if ((Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop).ProtectionStatus -eq 1) { $bl = 'on' } else { $bl = 'off' } } catch {}
$tpmReady = $null; try { $t = Get-Tpm -ErrorAction Stop; $tpmReady = [bool]($t.TpmPresent -and $t.TpmReady) } catch {}
$sb = $null; try { if (Confirm-SecureBootUEFI -ErrorAction Stop) { $sb = 'on' } else { $sb = 'off' } } catch {}
$defRt = $null; $defAge = $null; $avName = $null
$mp = $null; try { $mp = Get-MpComputerStatus -ErrorAction Stop } catch {}
if ($mp) { $defAge = [int]$mp.AntivirusSignatureAge }
# Security Center is authoritative for which AV is actually protecting the box
# (covers 3rd-party products, which put Defender in passive/real-time-off mode).
# Use the first ENABLED product (productState 'on' bit); else the first registered.
try { $avs = @(Get-CimInstance -Namespace root/SecurityCenter2 -Class AntiVirusProduct -ErrorAction Stop); $act = $avs | Where-Object { ((([int]$_.productState) -band 0x1000) -ne 0) } | Select-Object -First 1; if ($act) { $avName = "$($act.displayName)"; $defRt = $true } elseif ($avs.Count) { $avName = "$($avs[0].displayName)"; $defRt = $false } } catch {}
# No Security Center (e.g. Windows Server) → fall back to Defender's own real-time flag.
if (($null -eq $defRt) -and $mp) { if ($mp.AMServiceEnabled) { $avName = 'Windows Defender' }; $defRt = [bool]$mp.RealTimeProtectionEnabled }
# Defender's signature age only applies when Defender is the active AV.
if ($avName -and ($avName -notmatch 'Microsoft Defender|Windows Defender')) { $defAge = $null }
$wuDays = $null; try { $s = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher(); $n = $s.GetTotalHistoryCount(); if ($n -gt 0) { $h = $s.QueryHistory(0, [Math]::Min($n, 50)); $l = $h | Where-Object { $_.Operation -eq 1 -and $_.ResultCode -eq 2 } | Sort-Object Date -Descending | Select-Object -First 1; if ($l) { $wuDays = [int]((Get-Date) - $l.Date).TotalDays } } } catch {}
$sysPct = $null; try { $ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'" -ErrorAction Stop; if ($ld -and $ld.Size -gt 0) { $sysPct = [math]::Round((($ld.Size - $ld.FreeSpace) / $ld.Size) * 100, 1) } } catch {}
[ordered]@{
    bitlocker             = $bl
    defender_realtime     = $defRt
    defender_sig_age_days = $defAge
    av_product            = $avName
    tpm_ready             = $tpmReady
    secure_boot           = $sb
    updates_last_days     = $wuDays
    updates_pending       = $null
    system_drive_pct_used = $sysPct
} | ConvertTo-Json -Depth 3 -Compress
"""

# Local Administrators membership (spec 21 v2) — its OWN WinRM call so neither this
# nor PS_POSTURE overflows pywinrm's ~8 KB command line. Best-effort. Each member
# carries is_group (a nested group grant vs a user) and enabled (local-user account
# state; True for groups/domain members, whose state needs AD).
PS_ADMINS = r"""
$ErrorActionPreference = 'SilentlyContinue'
$admins = $null
try {
    $lu = @{}
    try { Get-LocalUser -ErrorAction Stop | ForEach-Object { $lu[$_.Name] = [bool]$_.Enabled } } catch {}
    $admins = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | ForEach-Object {
        $g = ($_.ObjectClass -eq 'Group')
        $short = ("$($_.Name)" -replace '^.*\\', '')
        $en = if ($g) { $true } elseif ($lu.ContainsKey($short)) { $lu[$short] } else { $true }
        @{ name = "$($_.Name)"; is_group = $g; enabled = $en } })
} catch {}
[ordered]@{ local_admins = @($admins) } | ConvertTo-Json -Depth 3 -Compress
"""


def _as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _clean(value) -> str | None:
    """Registry strings come back as "" for absent values (the PS "$(...)"
    coercion); normalize an empty/whitespace string to None."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    return v or None


def _parse(data: dict) -> tuple[Hardware, Health, str | None, list[Software]]:
    disks = [
        Disk(
            model=d.get("model"),
            size_gb=d.get("size_gb"),
            media_type=d.get("media_type"),
        )
        for d in _as_list(data.get("disks"))
        if isinstance(d, dict)
    ]
    hardware = Hardware(
        manufacturer=data.get("manufacturer"),
        model=data.get("model"),
        serial=data.get("serial"),
        hardware_uuid=data.get("hardware_uuid"),
        cpu=data.get("cpu"),
        cpu_cores=data.get("cpu_cores"),
        ram_gb=data.get("ram_gb"),
        gpu=data.get("gpu"),
        bios_version=data.get("bios_version"),
        disks=disks,
    )
    health = Health(
        os_name=data.get("os_name"),
        os_version=data.get("os_version"),
        os_build=data.get("os_build"),
        uptime_hours=data.get("uptime_hours"),
        free_disk_gb={k: v for k, v in (data.get("free_disk_gb") or {}).items()},
        logged_on_user=data.get("logged_on_user"),
    )
    software = [
        Software(
            name=_clean(s.get("name")),
            version=_clean(s.get("version")),
            publisher=_clean(s.get("publisher")),
            install_date=_clean(s.get("install_date")),
        )
        for s in _as_list(data.get("software"))
        if isinstance(s, dict) and _clean(s.get("name"))
    ]
    return hardware, health, data.get("hostname"), software


def _parse_posture(data: dict) -> Compliance:
    """Parse the PS_POSTURE JSON (spec 21) into a Compliance; a null signal (the
    collector couldn't read it) stays None = "unknown"."""
    return Compliance(
        bitlocker=_clean(data.get("bitlocker")),
        defender_realtime=data.get("defender_realtime"),
        defender_sig_age_days=data.get("defender_sig_age_days"),
        av_product=_clean(data.get("av_product")),
        tpm_ready=data.get("tpm_ready"),
        secure_boot=_clean(data.get("secure_boot")),
        updates_last_days=data.get("updates_last_days"),
        updates_pending=data.get("updates_pending"),
        system_drive_pct_used=data.get("system_drive_pct_used"),
    )


def _parse_admins(data: dict) -> list[LocalAdmin] | None:
    """Parse the PS_ADMINS JSON (spec 21 v2). None = couldn't read the group.
    ConvertTo-Json collapses a 1-element array to a scalar, so coerce to a list."""
    raw = data.get("local_admins")
    if raw is None:
        return None
    return [
        LocalAdmin(
            name=_clean(x.get("name")),
            is_group=bool(x.get("is_group")),
            enabled=bool(x.get("enabled", True)),
        )
        for x in _as_list(raw)
        if isinstance(x, dict) and _clean(x.get("name"))
    ]


def _winrm_username(username: str) -> str:
    """Normalize a credential username for pywinrm's NTLM.

    pywinrm sends a ``.\\name`` prefix as the NTLM *domain* ``.`` literally, which
    the target rejects (``InvalidCredentialsError``) — even though PowerShell's
    WSMan accepts ``.\\name``. A **bare** username authenticates against the host's
    local SAM, so strip a leading ``.\\`` (local-account shorthand). ``DOMAIN\\user``
    and ``user@domain`` are left untouched.
    """
    return username[2:] if username.startswith(".\\") else username


def collect_windows(
    ip: str, open_ports: list[int], profiles: list[CredentialProfile], config: Config
) -> dict:
    out: dict = {
        "hardware": None,
        "health": None,
        "hostname": None,
        "credential_profile": None,
        "software": None,
        "compliance": None,
        "errors": [],
    }
    port = config.ports.winrm
    if port not in open_ports:
        out["errors"].append("winrm_port_closed")
        return out

    # Record every profile's result, not just the last — one bad-last-profile
    # error used to mask which credential actually failed and why. Each line
    # carries the *qualified* username (what NTLM really sends), mirroring
    # diag_winrm.py so a failing host is diagnosable straight from the ingest.
    profile_errors: list[str] = []
    endpoint = f"{config.winrm_scheme}://{ip}:{port}/wsman"
    for prof in profiles:
        user = _winrm_username(prof.username)
        if not prof.password:
            profile_errors.append(f"[{prof.id}] user={user!r}: no password in .env")
            continue
        try:
            session = winrm.Session(
                endpoint,
                auth=(user, prof.password),
                transport=config.winrm_transport,
                server_cert_validation="ignore",
            )
            r = session.run_ps(PS_COLLECT)
            if r.status_code != 0:
                err = (r.std_err or b"")[:200].decode(errors="ignore").strip()
                profile_errors.append(
                    f"[{prof.id}] user={user!r}: ps_exit_{r.status_code} {err}"
                )
                continue
            raw = (r.std_out or b"").decode("utf-8", errors="ignore").strip() or "{}"
            hw, health, hostname, software = _parse(json.loads(raw))
            out.update(
                hardware=hw,
                health=health,
                hostname=hostname,
                credential_profile=prof.id,
                software=software,
            )
            # Security posture (spec 21): a second, small WinRM call on the same
            # authenticated session. Best-effort — the hardware collect has already
            # succeeded, so a posture failure (or an older host missing a cmdlet)
            # leaves compliance=None and never turns a good collect into a failure.
            try:
                pr = session.run_ps(PS_POSTURE)
                if pr.status_code == 0:
                    praw = (pr.std_out or b"").decode("utf-8", errors="ignore").strip() or "{}"
                    out["compliance"] = _parse_posture(json.loads(praw))
            except Exception:  # noqa: BLE001 — posture is optional, never fatal
                pass
            # Local administrators (spec 21 v2): a third small best-effort call.
            try:
                ar = session.run_ps(PS_ADMINS)
                if ar.status_code == 0:
                    araw = (ar.std_out or b"").decode("utf-8", errors="ignore").strip() or "{}"
                    admins = _parse_admins(json.loads(araw))
                    if admins is not None:
                        if out["compliance"] is None:
                            out["compliance"] = Compliance()
                        out["compliance"].local_admins = admins
            except Exception:  # noqa: BLE001 — optional, never fatal
                pass
            return out
        except Exception as e:  # noqa: BLE001 - report and try the next profile
            profile_errors.append(f"[{prof.id}] user={user!r}: {type(e).__name__}: {e}")
            continue

    detail = " | ".join(profile_errors) if profile_errors else "no credential profiles"
    out["errors"].append(
        f"auth_failed_all_profiles ({len(profile_errors)} profile(s): {detail})"
    )
    return out
