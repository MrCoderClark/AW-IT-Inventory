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
    winrm_transport: str = "ntlm"
    winrm_scheme: str = "http"
    concurrency: int = 64
    connect_timeout: float = 0.6
    winrm_timeout: int = 25
    snmp_timeout: float = 2.0
    output_dir: str = "out"

    @property
    def profiles_by_id(self) -> dict[str, CredentialProfile]:
        return {p.id: p for p in self.profiles}


def load_env(path: Path | None = None) -> None:
    """Minimal .env loader (KEY=VALUE lines) into os.environ; no overwrite."""
    env_path = path or (BASE_DIR / ".env")
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def load_config(path: str | Path = "config.yaml") -> Config:
    load_env()
    cfg_path = Path(path)
    if not cfg_path.is_absolute():
        cfg_path = BASE_DIR / cfg_path
    data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    return Config.model_validate(data)
