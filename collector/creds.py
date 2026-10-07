"""Credential resolution: pick which profiles to try for a host, in order.

Rules are evaluated top-down; the first match yields an ordered candidate list.
Since a host's OS is usually unknown before we authenticate, rules key mainly
on subnet — with a fallback that tries every profile.
"""

from __future__ import annotations

import ipaddress
import socket

from config import Config, CredentialProfile


def _short_hostname(ip: str) -> str | None:
    """Reverse-resolve an IP to its short (NetBIOS-style) hostname, or None.

    Used to machine-qualify a local-account username (`HOSTNAME\\user`) so NTLM
    hits the target's local SAM instead of the domain. Best-effort: a missing PTR
    record just means we fall back to the bare username.
    """
    try:
        return socket.gethostbyaddr(ip)[0].split(".")[0] or None
    except Exception:  # noqa: BLE001 — any resolution failure → bare username
        return None


def _qualify(ip: str, profiles: list[CredentialProfile]) -> list[CredentialProfile]:
    """Machine-qualify any `qualify` profile with the target's hostname. The DNS
    lookup runs at most once per host, and only when a qualify profile is present."""
    host: str | None = None
    resolved = False
    out: list[CredentialProfile] = []
    for p in profiles:
        bare = "\\" not in p.username and "@" not in p.username
        if p.qualify and bare:
            if not resolved:
                host = _short_hostname(ip)
                resolved = True
            if host:
                out.append(p.model_copy(update={"username": f"{host}\\{p.username}"}))
                continue
        out.append(p)
    return out


def _match(match: dict, ip: str) -> bool:
    if match.get("any"):
        return True
    subnet = match.get("subnet")
    if subnet:
        try:
            if ipaddress.ip_address(ip) not in ipaddress.ip_network(subnet):
                return False
        except ValueError:
            return False
    return True


def resolve_profiles(ip: str, config: Config) -> list[CredentialProfile]:
    by_id = config.profiles_by_id
    for rule in config.rules:
        if _match(rule.match, ip):
            ordered = [by_id[p] for p in rule.try_ if p in by_id]
            if ordered:
                return _qualify(ip, ordered)
    return _qualify(ip, list(config.profiles))  # fallback: try all
