"""Windows collection over WinRM: one PowerShell call returns CIM data as JSON.

Tries each candidate credential profile until one authenticates; records which
profile worked (so a future run can go straight to it).
"""

from __future__ import annotations

import json

import winrm

from config import Config, CredentialProfile
from models import Disk, Hardware, Health

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
} | ConvertTo-Json -Depth 5 -Compress
"""


def _as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _parse(data: dict) -> tuple[Hardware, Health, str | None]:
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
    return hardware, health, data.get("hostname")


def collect_windows(
    ip: str, open_ports: list[int], profiles: list[CredentialProfile], config: Config
) -> dict:
    out: dict = {
        "hardware": None,
        "health": None,
        "hostname": None,
        "credential_profile": None,
        "errors": [],
    }
    port = config.ports.winrm
    if port not in open_ports:
        out["errors"].append("winrm_port_closed")
        return out

    last_err = None
    endpoint = f"{config.winrm_scheme}://{ip}:{port}/wsman"
    for prof in profiles:
        try:
            session = winrm.Session(
                endpoint,
                auth=(prof.username, prof.password),
                transport=config.winrm_transport,
                server_cert_validation="ignore",
            )
            r = session.run_ps(PS_COLLECT)
            if r.status_code != 0:
                err = (r.std_err or b"")[:200]
                last_err = f"{prof.id}: ps_exit_{r.status_code} {err.decode(errors='ignore')}"
                continue
            raw = (r.std_out or b"").decode("utf-8", errors="ignore").strip() or "{}"
            hw, health, hostname = _parse(json.loads(raw))
            out.update(
                hardware=hw,
                health=health,
                hostname=hostname,
                credential_profile=prof.id,
            )
            return out
        except Exception as e:  # noqa: BLE001 - report and try next profile
            last_err = f"{prof.id}: {type(e).__name__}: {e}"
            continue

    out["errors"].append(f"auth_failed_all_profiles ({last_err})")
    return out
