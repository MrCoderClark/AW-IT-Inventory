"""Per-phone web credentials for the authenticated phone read (spec 27 phase 2).

Loaded from a gitignored CSV on the collector host (`ip,username,password`) — never
the DB or git, the same rule as the WinRM secrets. Keyed by IP (what the collector
knows while scanning); blank/comment lines are ignored. The parse is cached per file
path so a sweep doesn't re-read it per phone.

CSV:
    ip,username,password
    192.168.75.62,admin,22903756052
"""

from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path

from config import Config


class PhoneCredential:
    __slots__ = ("username", "password")

    def __init__(self, username: str, password: str) -> None:
        self.username = username
        self.password = password

    def __repr__(self) -> str:  # never print the password
        return f"PhoneCredential(username={self.username!r}, password=***)"


@lru_cache(maxsize=8)
def _load(path_str: str, mtime: float) -> dict[str, PhoneCredential]:
    """Parse the CSV into {ip: PhoneCredential}. A missing file is not an error —
    it just means no phone has credentials yet (phase-1 discovery still works)."""
    path = Path(path_str)
    out: dict[str, PhoneCredential] = {}
    if not path.exists():
        return out
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        for row in reader:
            if not row:
                continue
            cells = [c.strip() for c in row]
            # Skip a header row and blank/comment lines.
            if cells[0].lower() in ("ip", "#ip", "") or cells[0].startswith("#"):
                continue
            if len(cells) < 3:
                continue
            ip, username, password = cells[0], cells[1], cells[2]
            if ip and password:
                out[ip] = PhoneCredential(username or "admin", password)
    return out


def load_phone_credentials(config: Config) -> dict[str, PhoneCredential]:
    """The full {ip: PhoneCredential} map from the configured CSV.

    Cached per path+mtime so editing the CSV while the worker is running
    (adding a newly racked phone) is picked up on the next scan.
    """
    path = config.phone_credentials_path
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {}
    return _load(str(path), mtime)


def resolve_phone_credential(config: Config, ip: str) -> PhoneCredential | None:
    """The web credential for a phone at `ip`, or None when it has no row (the
    scan then stays credential-free for that phone: MAC/model only)."""
    return load_phone_credentials(config).get(ip)


def clear_cache() -> None:
    """Drop the parsed-file cache (for tests, or after editing the CSV live)."""
    _load.cache_clear()
