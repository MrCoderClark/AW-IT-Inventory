"""Config loading: structure from YAML, secrets from environment (.env).

Passwords never live in the YAML — each credential profile names an env var
(`password_env`) that holds the secret, kept in a gitignored .env.
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent


class CredentialProfile(BaseModel):
    id: str
    username: str
    password_env: str
    # A LOCAL account on a domain-joined machine must be machine-qualified
    # (`HOSTNAME\user`) or NTLM routes a bare name to the domain and rejects it.
    # When true, the collector reverse-resolves the target IP to its hostname and
    # qualifies the username at auth time (falls back to the bare name if the
    # hostname can't be resolved). See creds.resolve_profiles.
    qualify: bool = False

    @property
    def password(self) -> str:
        return os.environ.get(self.password_env, "")


class Rule(BaseModel):
    # e.g. {"subnet": "192.168.72.0/24"} or {"any": true}
    match: dict = Field(default_factory=dict)
    # ordered list of profile ids to try
    try_: list[str] = Field(default_factory=list, alias="try")

    model_config = {"populate_by_name": True}


class Ports(BaseModel):
    winrm: int = 5985
    smb: int = 445
    printer: int = 9100


class Config(BaseModel):
    networks: list[str] = Field(default_factory=list)
    ports: Ports = Field(default_factory=Ports)
    profiles: list[CredentialProfile] = Field(default_factory=list)
    rules: list[Rule] = Field(default_factory=list)
    snmp_community: str = "public"
    # SNMP version to use for printers: "auto" tries v2c then falls back to v1,
    # "v2c" or "v1" pin one. Some devices (e.g. the Canon imageFORCE) answer only
    # v1 and silently drop v2c, so "auto" reads them without extra config.
    snmp_version: str = "auto"
    winrm_transport: str = "ntlm"
    winrm_scheme: str = "http"
    concurrency: int = 64
    connect_timeout: float = 2.0
    winrm_timeout: int = 25
    snmp_timeout: float = 2.0
    output_dir: str = "out"

    # Ingest (used with `scan --ingest`). Secrets come from env.
    auth_url: str = "http://127.0.0.1:8000"
    ingest_url: str = "http://localhost:3000"
    client_id_env: str = "OPUS_CLIENT_ID"
    client_secret_env: str = "OPUS_CLIENT_SECRET"

    # Discovery type toggles (spec 13): the automatic `scan` sweep pulls these
    # from the web app first and skips an off type. The last good result is
    # cached here so a settings outage never stops scanning. Not a secret.
    discovery_cache_file: str = ".discovery-settings.json"

    # Worker (spec 12): the long-running `worker` command.
    worker_poll_interval: float = 5.0  # seconds between claim polls
    # The cut-out worker's own poll interval (spec 18 phase 3). Background removal
    # is on-demand, so it polls on a calmer cadence than the 5s scan-job loop — a
    # requested cut-out starts within this window. Raise it to reduce chatter.
    cutout_poll_interval: float = 60.0
    # rembg model for background removal. `u2net` (~176 MB) is a good default;
    # `u2netp` (~5 MB) is lighter/faster for low-memory hosts. DON'T use rembg's
    # new default `bria-rmbg-2.0` (~1 GB) — it OOMs modest machines.
    cutout_model: str = "u2net"
    # Remote printer install / list / remove (spec 20). The worker polls the op
    # queue on this cadence when no scan job is waiting. Kept short so interactive
    # "scan printers" / "remove" feel responsive.
    printer_install_poll_interval: float = 5.0
    # Temp dir on the TARGET computer where the driver bundle is staged + unpacked
    # (cleaned up after each job).
    install_temp_dir: str = r"C:\Windows\Temp\opus-print"
    # Transfer the driver bundle to the target over the SMB admin share (C$); when
    # False (or 445 is closed), fall back to base64 chunks over WinRM.
    install_smb_transfer: bool = True
    # Times of day the printer reachability checks fire (local to schedule_tz).
    schedule_times: list[str] = Field(default_factory=lambda: ["08:00", "13:00", "18:00"])
    # Explicit zone for the schedule so fire times don't drift with the host OS
    # or DST. None = the host's local zone. e.g. "America/New_York".
    schedule_timezone: str | None = None
    daily_snmp_time: str = "08:00"  # which check of the day also does full SNMP
    # Scheduled computer sweep: times of day (HH:MM, local to schedule_timezone) to
    # WinRM-collect every manually-entered computer (a Computer asset with an IP).
    # A targeted scan of listed hosts, NOT a subnet discovery, so it bypasses the
    # discovery toggles. Empty = off.
    computer_sweep_times: list[str] = Field(default_factory=list)
    reachability_ports: list[int] = Field(default_factory=lambda: [9100, 631, 515])
    reachability_timeout: float = 1.5  # TCP connect timeout (seconds)
    reachability_retention_days: int = 365  # prune printer_checks older than this

    # Printer page counter (spec 14). Candidate OIDs for a printer's total page
    # counter, tried IN ORDER; the first that returns a number wins. This lets one
    # config serve a mixed fleet: a vendor "total" OID first (matching the number
    # the device shows on its own counter page), with the standard Printer-MIB
    # prtMarkerLifeCount as a universal fallback. Each candidate is read in its own
    # SNMP GET, so a model that lacks one just falls through to the next (important
    # under SNMP v1, where a missing OID fails the whole request). The default has
    # Canon's "Total 2" (counter 102, e.g. iR-ADV / imageFORCE) first.
    counter_oids: list[str] = Field(
        default_factory=lambda: [
            "1.3.6.1.4.1.1602.1.11.1.3.1.4.102",  # Canon "Total 2"
            "1.3.6.1.2.1.43.10.2.1.4.1.1",  # standard prtMarkerLifeCount
        ]
    )
    # When the worker sends the daily counter report (local to schedule_timezone),
    # default just after the 08:00 SNMP collect so the day's reading is in first.
    counter_report_time: str = "08:05"

    # Notifications (spec 19): times of day (HH:MM, local to schedule_timezone) to
    # run the warranty-expiry notification sweep. Web computes and dedupes, so
    # running daily never spams. Empty = off. Default once each morning.
    notification_sweep_times: list[str] = Field(default_factory=lambda: ["07:30"])

    @property
    def profiles_by_id(self) -> dict[str, CredentialProfile]:
        return {p.id: p for p in self.profiles}

    @property
    def client_id(self) -> str:
        return os.environ.get(self.client_id_env, "")

    @property
    def client_secret(self) -> str:
        return os.environ.get(self.client_secret_env, "")

    @property
    def discovery_cache_path(self) -> Path:
        p = Path(self.discovery_cache_file)
        return p if p.is_absolute() else BASE_DIR / p


def load_env(path: Path | None = None) -> None:
    """Minimal .env loader (KEY=VALUE lines) into os.environ.

    A real OS environment variable always wins (so you can override .env from the
    shell). Among the .env lines themselves, the LAST occurrence of a key wins —
    so editing a value by adding a new line (leaving a stale earlier one) still
    uses the new value, instead of silently keeping the old one.
    """
    env_path = path or (BASE_DIR / ".env")
    if not env_path.exists():
        return
    preexisting = set(os.environ)  # OS-level vars take precedence over .env
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key in preexisting:
            continue
        os.environ[key] = value


def load_config(path: str | Path = "config.yaml") -> Config:
    load_env()
    cfg_path = Path(path)
    if not cfg_path.is_absolute():
        cfg_path = BASE_DIR / cfg_path
    data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    return Config.model_validate(data)
