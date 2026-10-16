"""Discovery target expansion: a /32 (or bare IP) must still be probed.

``ipaddress.IPv4Network.hosts()`` skips network/broadcast, which for a single-host
network is the address itself. Manual Scan now jobs pass bare IPs; ``--target
x.x.x.x/32`` does the same. Without this, those runs discover zero hosts.
"""

from __future__ import annotations

from discovery import _hosts_in


def test_hosts_in_includes_bare_ip():
    assert _hosts_in(["192.168.75.41"]) == [
        ("192.168.75.41", "192.168.75.41/32"),
    ]


def test_hosts_in_includes_slash32():
    assert _hosts_in(["192.168.75.64/32"]) == [
        ("192.168.75.64", "192.168.75.64/32"),
    ]


def test_hosts_in_slash24_skips_network_and_broadcast():
    hosts = _hosts_in(["192.168.75.0/24"])
    ips = {ip for ip, _ in hosts}
    assert "192.168.75.0" not in ips
    assert "192.168.75.255" not in ips
    assert "192.168.75.41" in ips
    assert len(hosts) == 254
    assert all(subnet == "192.168.75.0/24" for _, subnet in hosts)


def test_hosts_in_skips_invalid():
    assert _hosts_in(["not-an-ip", "192.168.75.41"]) == [
        ("192.168.75.41", "192.168.75.41/32"),
    ]
