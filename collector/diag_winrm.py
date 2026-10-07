"""Standalone WinRM auth diagnostic (spec 20 troubleshooting).

Usage:  uv run python diag_winrm.py <ip>

For each credential profile the collector would try for <ip>, prints the exact
username used (AFTER qualification), whether a password is loaded from .env, and
the real per-profile auth result — so a failing host can be diagnosed without an
install job and without the single-last-error masking.
"""

from __future__ import annotations

import sys

import winrm

from collect_windows import _winrm_username
from config import load_config
from creds import resolve_profiles


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: uv run python diag_winrm.py <ip>")
        return 2
    ip = sys.argv[1]
    config = load_config("config.yaml")
    profiles = resolve_profiles(ip, config)
    if not profiles:
        print(f"No credential profiles resolve for {ip}.")
        return 1

    endpoint = f"{config.winrm_scheme}://{ip}:{config.ports.winrm}/wsman"
    print(f"Target {ip} ({endpoint}) — trying {len(profiles)} profile(s):\n")

    for p in profiles:
        user = _winrm_username(p.username)
        pw_set = bool(p.password)
        label = f"  [{p.id}] user={user!r} pw_set={pw_set}"
        if not pw_set:
            print(label + "  -> SKIP (no password in .env)")
            continue
        try:
            s = winrm.Session(
                endpoint,
                auth=(user, p.password),
                transport=config.winrm_transport,
                server_cert_validation="ignore",
            )
            r = s.run_ps("$env:COMPUTERNAME")
            if r.status_code == 0:
                out = (r.std_out or b"").decode(errors="ignore").strip()
                print(label + f"  -> OK  (COMPUTERNAME={out})")
                print("\n==> This profile authenticates; the collector will use it.")
                return 0
            err = (r.std_err or b"").decode(errors="ignore").strip()[:200]
            print(label + f"  -> ps_exit_{r.status_code} {err}")
        except Exception as e:  # noqa: BLE001
            print(label + f"  -> {type(e).__name__}: {e}")

    print("\n==> No profile authenticated. See the per-profile errors above.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
