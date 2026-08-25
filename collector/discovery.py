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
    return "unknown"


def _hosts_in(networks: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for net in networks:
        try:
            network = ipaddress.ip_network(net, strict=False)
        except ValueError:
            continue
        for host in network.hosts():
            out.append((str(host), str(network)))
    return out


def discover(config: Config, limit: int | None = None) -> list[dict]:
    """Return reachable hosts with their open ports and device classification."""
    targets = _hosts_in(config.networks)
    if limit:
        targets = targets[:limit]
    ports = [config.ports.winrm, config.ports.smb, config.ports.printer]

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
