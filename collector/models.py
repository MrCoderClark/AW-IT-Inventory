"""Typed scan-result models (normalized, ready to ingest later)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class Disk(BaseModel):
    model: str | None = None
    size_gb: float | None = None
    media_type: str | None = None


class Hardware(BaseModel):
    manufacturer: str | None = None
    model: str | None = None
    serial: str | None = None
    hardware_uuid: str | None = None
    cpu: str | None = None
    cpu_cores: int | None = None
    ram_gb: float | None = None
    gpu: str | None = None
    bios_version: str | None = None
    disks: list[Disk] = Field(default_factory=list)


class Health(BaseModel):
    os_name: str | None = None
    os_version: str | None = None
    os_build: str | None = None
    uptime_hours: float | None = None
    free_disk_gb: dict[str, float] = Field(default_factory=dict)
    logged_on_user: str | None = None


class Software(BaseModel):
    """One installed program read from a Windows registry Uninstall key (spec 15).
    Registry values are strings (or absent); `install_date` is left as-is."""

    name: str | None = None
    version: str | None = None
    publisher: str | None = None
    install_date: str | None = None


class Compliance(BaseModel):
    """Security-posture signals (spec 21). Every field is best-effort — a signal
    the collector couldn't read is ``None`` ("unknown"), never an error. The
    🟢/🟡/🔴 verdicts and the health score are derived web-side from these raw
    values; the collector only reports what it observed."""

    bitlocker: str | None = None  # "on" | "off" | None=unknown (system drive)
    defender_realtime: bool | None = None  # real-time protection enabled?
    defender_sig_age_days: int | None = None  # AV signature age in days
    av_product: str | None = None  # product name (Defender or 3rd-party), or None
    tpm_ready: bool | None = None  # TPM present AND ready?
    secure_boot: str | None = None  # "on" | "off" | None=unknown/not-applicable
    updates_last_days: int | None = None  # days since the last successful update
    updates_pending: int | None = None  # pending count (None in v1 — not read yet)
    system_drive_pct_used: float | None = None  # % full of the system drive


class PrinterInfo(BaseModel):
    description: str | None = None
    model: str | None = None
    serial: str | None = None
    page_count: int | None = None
    status: str | None = None
    supplies: dict[str, int] = Field(default_factory=dict)


class HostResult(BaseModel):
    ip: str
    subnet: str
    device_type: str = "unknown"  # windows | printer | unknown
    reachable: bool = False
    open_ports: list[int] = Field(default_factory=list)
    hostname: str | None = None
    credential_profile: str | None = None
    hardware: Hardware | None = None
    health: Health | None = None
    printer: PrinterInfo | None = None
    # Installed programs matching interest (spec 15). None = not collected (a
    # non-Windows host, or a software read that failed); an empty list = read OK,
    # nothing found. The web app filters this to the watchlist at ingest.
    software: list[Software] | None = None
    # Security posture (spec 21). None = not collected (non-Windows, or the whole
    # posture read failed); individual unreadable signals are None *within* it.
    compliance: Compliance | None = None
    errors: list[str] = Field(default_factory=list)


class RunReport(BaseModel):
    run_id: str
    started_at: str
    finished_at: str | None = None
    networks: list[str] = Field(default_factory=list)
    hosts: list[HostResult] = Field(default_factory=list)
