"""Host discovery + classification via TCP connect probes.

TCP probes need no admin rights and work reliably on Windows (unlike raw
ICMP/ARP). A host is "reachable" if any probed port answers.
"""

from __future__ import annotations

import ipaddress
import socket
from concurrent.futures import ThreadPoolExecutor

from config import Config


def _probe_port(ip: str, port: int, timeout: float) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex((ip, port)) == 0
    except OSError:
        return False


def _probe_host(ip: str, ports: list[int], timeout: float) -> list[int]:
    return [p for p in ports if _probe_port(ip, p, timeout)]


def classify(open_ports: list[int], config: Config) -> str:
    p = config.ports
    if p.winrm in open_ports or p.smb in open_ports:
        return "windows"
    if p.printer in open_ports:
        return "printer"
    # A host whose only signal is the phone web port (443) is a phone *candidate*
    # (spec 27); the collect step confirms it via the device TLS cert and downgrades
    # a non-Yealink HTTPS device back to "unknown". Windows/printer take priority, so
    # a server that also serves 443 is not misread as a phone.
    if p.phone in open_ports:
        return "phone"
    return "unknown"


def _hosts_in(networks: list[str]) -> list[tuple[str, str]]:
    """Expand each CIDR (or bare IP) to ``(ip, subnet)`` pairs to probe.

    ``IPv4Network.hosts()`` skips the network and broadcast addresses, which for
    a ``/32`` (and IPv6 ``/128``) means *the only address* is dropped. Manual
    Scan now jobs and ``--target 10.0.0.5/32`` both pass a single host, so those
    would discover nothing and report "unreachable" even when the device is up.
    """
    out: list[tuple[str, str]] = []
    for net in networks:
        try:
            network = ipaddress.ip_network(net, strict=False)
        except ValueError:
            continue
        subnet = str(network)
        if network.num_addresses == 1:
            out.append((str(network.network_address), subnet))
            continue
        for host in network.hosts():
            out.append((str(host), subnet))
    return out


def discover(config: Config, limit: int | None = None) -> list[dict]:
    """Return reachable hosts with their open ports and device classification."""
    targets = _hosts_in(config.networks)
    if limit:
        targets = targets[:limit]
    ports = [
        config.ports.winrm,
        config.ports.smb,
        config.ports.printer,
        config.ports.phone,
    ]

    def work(item: tuple[str, str]) -> dict | None:
        ip, subnet = item
        found = _probe_host(ip, ports, config.connect_timeout)
        if not found:
            return None
        return {"ip": ip, "subnet": subnet, "open_ports": found}

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=config.concurrency) as pool:
        for res in pool.map(work, targets):
            if res:
                res["device_type"] = classify(res["open_ports"], config)
                results.append(res)
    return results
