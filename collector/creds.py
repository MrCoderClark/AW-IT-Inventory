"""Credential resolution: pick which profiles to try for a host, in order.

Rules are evaluated top-down; the first match yields an ordered candidate list.
Since a host's OS is usually unknown before we authenticate, rules key mainly
on subnet — with a fallback that tries every profile.
"""

from __future__ import annotations

import ipaddress

from config import Config, CredentialProfile


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
                return ordered
    return list(config.profiles)  # fallback: try all
