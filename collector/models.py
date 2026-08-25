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
    errors: list[str] = Field(default_factory=list)


class RunReport(BaseModel):
    run_id: str
    started_at: str
    finished_at: str | None = None
    networks: list[str] = Field(default_factory=list)
    hosts: list[HostResult] = Field(default_factory=list)
