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


class NetworkAdapter(BaseModel):
    """One connected network adapter (spec 21 v2)."""

    name: str | None = None
    mac: str | None = None
    status: str | None = None
    ips: list[str] = Field(default_factory=list)


class Health(BaseModel):
    os_name: str | None = None
    os_version: str | None = None
    os_build: str | None = None
    uptime_hours: float | None = None
    free_disk_gb: dict[str, float] = Field(default_factory=dict)
    logged_on_user: str | None = None  # current console user (from PS_COLLECT)
    # Endpoint detail (spec 21 v2), merged in from PS_ENDPOINT. None = not collected.
    network_adapters: list[NetworkAdapter] | None = None
    logged_on_users: list[str] | None = None  # all interactive sessions


class Software(BaseModel):
    """One installed program read from a Windows registry Uninstall key (spec 15).
    Registry values are strings (or absent); `install_date` is left as-is."""

    name: str | None = None
    version: str | None = None
    publisher: str | None = None
    install_date: str | None = None
    install_location: str | None = None
    arch: str | None = None  # "x64" | "x86" | "user" (from the registry hive)


class LocalAdmin(BaseModel):
    """One member of the local Administrators group (spec 21 v2). ``is_group`` marks
    a nested group grant (e.g. ``DOMAIN\\Domain Admins``) vs an individual user;
    ``enabled`` is the account state for a LOCAL user (True for groups and domain
    members, whose state the collector can't read without AD)."""

    name: str | None = None
    is_group: bool = False
    enabled: bool = True


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
    local_admins: list[LocalAdmin] | None = None  # local Administrators members


class Monitor(BaseModel):
    """A display connected to a computer, decoded from its EDID (spec 25). Best-
    effort — a headless, virtual, or serial-less ("Generic PnP Monitor") display may
    yield no serial. The 3-letter PnP vendor code is mapped to a vendor name
    web-side; the collector reports only what the EDID gave."""

    vendor_code: str | None = None  # 3-letter PnP code, e.g. "DEL"
    model: str | None = None
    serial: str | None = None
    product_code: str | None = None
    year: int | None = None
    active: bool = True
    diagonal_in: float | None = None
    # Native mode, parsed from the EDID preferred (first) detailed timing: the
    # panel's real resolution and refresh. None when the raw EDID is unreadable.
    resolution: str | None = None  # e.g. "1920x1080"
    refresh_hz: int | None = None


class PrinterInfo(BaseModel):
    description: str | None = None
    model: str | None = None
    serial: str | None = None
    page_count: int | None = None
    status: str | None = None
    supplies: dict[str, int] = Field(default_factory=dict)


class PhoneInfo(BaseModel):
    """VoIP desk phone inventory (spec 27). Phase 1 reads mac + model with no
    credentials (TLS cert CN = MAC, HTTPS title = model). Phase 2 adds vendor,
    serial (Yealink "Machine ID"), firmware, extension (SIP label), display
    name, and register status via the device's web UI (T5x ``/api`` or T4x
    ``/servlet`` login). None = not collected."""

    mac: str | None = None  # the reconciliation key, from the device TLS cert CN
    model: str | None = None  # e.g. "T54W" (phase 2) or "Yealink T54W" (phase 1 title)
    vendor: str | None = None  # "Yealink" — locked by the cert's issuer in phase 2
    serial: str | None = None  # Yealink Machine ID, e.g. "301081C101210254"
    firmware: str | None = None
    extension: str | None = None  # SIP account Label, e.g. "117"
    display_name: str | None = None  # SIP account Display Name, e.g. "Joseph Clark"
    register_status: str | None = None  # "Registered" | "Unregistered" | …


class HostResult(BaseModel):
    ip: str
    subnet: str
    device_type: str = "unknown"  # windows | printer | phone | unknown
    reachable: bool = False
    open_ports: list[int] = Field(default_factory=list)
    hostname: str | None = None
    credential_profile: str | None = None
    hardware: Hardware | None = None
    health: Health | None = None
    printer: PrinterInfo | None = None
    # VoIP desk phone inventory (spec 27). None = not a phone / not collected.
    phone: PhoneInfo | None = None
    # Installed programs matching interest (spec 15). None = not collected (a
    # non-Windows host, or a software read that failed); an empty list = read OK,
    # nothing found. The web app filters this to the watchlist at ingest.
    software: list[Software] | None = None
    # Security posture (spec 21). None = not collected (non-Windows, or the whole
    # posture read failed); individual unreadable signals are None *within* it.
    compliance: Compliance | None = None
    # Connected displays from EDID (spec 25). None = not collected (non-Windows, or
    # the read failed); an empty list = read OK, no displays detected.
    monitors: list[Monitor] | None = None
    errors: list[str] = Field(default_factory=list)


class RunReport(BaseModel):
    run_id: str
    started_at: str
    finished_at: str | None = None
    networks: list[str] = Field(default_factory=list)
    hosts: list[HostResult] = Field(default_factory=list)
